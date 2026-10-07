const { WebSocketServer, WebSocket } = require("ws");
const mailStore = require("../Mail/mailStore.js");
const { canSeeEmail } = require("../Mail/branchRouting.js");

let wss = null;
let db = null;

// Only clients whose user account has this role receive email updates.
const EMAIL_UPDATE_ROLE = "2";

// How long a dropped connection's claimed emails stay reserved before they are
// returned to the pool (and marked unread), giving the worker a moment to
// reconnect or the next page time to claim the email itself.
const RELEASE_GRACE_MS = Number(process.env.EMAIL_RELEASE_GRACE_MS) || 3000;

// Whether any currently open connection holds the claim on this email.
function isHeldByOpenConnection(messageId) {
  if (!wss) return false;
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.claimedEmails &&
      client.claimedEmails.has(messageId)
    ) {
      return true;
    }
  }
  return false;
}

function isNotFoundError(err) {
  const status = err && (err.code || err.status || err.response?.status);
  return Number(status) === 404 || Number(status) === 400;
}

/**
 * Load an email that is no longer held in memory back into the mail store,
 * straight from Gmail, without showing a card to other workers. Used when a
 * worker reconnects with the email's form still open after a server restart.
 *
 * Emails completed or dismissed during this server run are never restored.
 * Each registered inbox is tried in turn, because the message ID alone does
 * not say which inbox it belongs to.
 *
 * @param {string} messageId  Gmail message ID.
 * @returns {Promise<Object|null>} The stored email, or null when not found
 *   or not from a known broker.
 */
async function restoreEmail(messageId) {
  if (mailStore.wasHandled(messageId)) return null;
  // Lazy require: ProcessEmail requires this module (circular dependency).
  const { ProcessEmail } = require("../Mail/ProcessEmail.js");
  for (const [account, gmail] of mailStore.listGmail()) {
    if (!gmail) continue;
    try {
      const email = await ProcessEmail(gmail, messageId, account, {
        notify: false,
      });
      if (email) return email;
      // Already stored meanwhile (e.g. by a poll sweep), or not a broker email.
      const stored = mailStore.get(messageId);
      if (stored) return stored;
      return null;
    } catch (err) {
      // Not in this inbox: try the next one. Any other failure is real.
      if (isNotFoundError(err)) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Attach the WebSocket server to the existing HTTP server and keep a
 * reference to the database connection for token verification.
 *
 * @param {import("http").Server} server  Existing HTTP server (port 5501).
 * @param {import("mysql2/promise").Connection} DBConnection  MySQL connection.
 */
module.exports.initWsServer = function initWsServer(server, DBConnection) {
  db = DBConnection;
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "ws://localhost").pathname;
    } catch {
      pathname = "/";
    }

    if (pathname !== "/ws") {
      // Reject with a complete, self-terminating response. A bare status line
      // carries no Content-Length and no Connection header, so a reverse proxy
      // in front of this process can mis-frame it and leave the socket in an
      // ambiguous state for the client.
      console.warn(`Rejected WebSocket upgrade for unknown path: ${pathname}`);
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Content-Length: 0\r\n" +
          "Connection: close\r\n" +
          "\r\n"
      );
      socket.destroy();
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (err) {
      console.error("WebSocket upgrade failed:", err);
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    ws.username = null;
    ws.role = null;
    ws.branch = "";
    ws.isAlive = true;
    // Email cards claimed through this specific connection. Used to release
    // them if the worker client drops (power loss / network failure) so other
    // workers can pick them up again.
    ws.claimedEmails = new Set();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data) => {
      handleMessage(ws, data).catch((err) => {
        console.error("WebSocket message handling failed:", err);
      });
    });

    ws.on("close", () => {
      // Release every email card this connection still holds. A worker that is
      // no longer connected must not keep cards reserved forever; return them
      // to the shared pool (marked unread again) so another worker can claim
      // them. If the worker reconnects with the form still open, the client
      // claims the email again, which marks it read and taken once more.
      //
      // The release waits a short grace period first. Opening a card closes
      // the dashboard's connection right before the form page claims the
      // email on its own connection, and a brief network blip reconnects
      // within a second or two. Neither should flip the card and the Gmail
      // read state back and forth.
      const claimed = Array.from(ws.claimedEmails);
      ws.claimedEmails.clear();
      if (claimed.length === 0) return;
      const username = ws.username;
      setTimeout(() => {
        for (const messageId of claimed) {
          const email = mailStore.get(messageId);
          if (!email) continue;
          // Only release if this user still holds the claim and has not
          // re-claimed it on a newer connection in the meantime. The card may
          // also have been released/completed and claimed by someone else.
          if (mailStore.getClaimer(messageId) !== username) continue;
          if (isHeldByOpenConnection(messageId)) continue;
          releaseEmail(email, messageId).catch((err) => {
            console.error("Failed to release email of closed connection:", err);
          });
        }
      }, RELEASE_GRACE_MS);
    });
  });

  // Heartbeat to drop dead connections from Electron clients.
  setInterval(() => {
    for (const client of wss.clients) {
      try {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      } catch (err) {
        console.error("WebSocket heartbeat failed:", err);
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, 30000);

  return wss;
};

/**
 * Return an email to the shared pool after its worker cancelled the form or
 * lost the connection: unclaim it, show the card to every worker again and
 * mark the Gmail message unread.
 *
 * The release time is stamped before and after the Gmail request so a poll
 * sweep that started in the meantime (and may have seen the message as read)
 * does not drop the card.
 *
 * @param {Object} email  The stored email.
 * @param {string} messageId  Gmail message ID.
 */
async function releaseEmail(email, messageId) {
  mailStore.unclaim(messageId);
  mailStore.touchReleased(messageId);
  broadcast({ type: "email_released", data: email }, email);
  try {
    await mailStore.syncReadState(email.account, messageId);
  } catch (err) {
    console.error("Failed to mark released email as unread:", err);
  } finally {
    mailStore.touchReleased(messageId);
  }
}

async function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (err) {
    console.error("Failed to parse WebSocket message:", err);
    return;
  }

  if (msg.type === "auth") {
    try {
      const [rows] = await db.query(
        "SELECT t.Username, u.Role FROM tokens t JOIN users u ON u.Username = t.Username WHERE t.Token = ? AND t.Expires > NOW()",
        [msg.token]
      );

      if (rows && rows.length > 0) {
        const username = rows[0].Username;
        ws.username = username;
        ws.role = rows[0].Role;
        // Branch the worker selected at login; used to restrict which
        // brokers' emails this worker may see.
        ws.branch = typeof msg.branch === "string" ? msg.branch : "";
        ws.send(JSON.stringify({ type: "auth_ok", username }));
      } else {
        ws.send(
          JSON.stringify({
            type: "auth_error",
            error: "Invalid or expired token",
          })
        );
      }
    } catch (err) {
      console.error("WebSocket auth error:", err);
      ws.send(JSON.stringify({ type: "auth_error", error: "Auth failed" }));
    }
  } else if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
  } else if (msg.type === "list_emails") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      ws.send(JSON.stringify({ type: "list_emails", data: [] }));
      return;
    }
    const data = mailStore
      .listAll()
      .filter((email) => canSeeEmail(ws.branch, email));
    ws.send(JSON.stringify({ type: "list_emails", data }));
  } else if (msg.type === "get_attachment") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const id = msg.id || null;
    const email = messageId ? mailStore.get(messageId) : null;
    if (!email || !id || !canSeeEmail(ws.branch, email)) {
      ws.send(
        JSON.stringify({ type: "get_attachment", ok: false, id, error: "Not found" })
      );
      return;
    }
    try {
      // Lazy require avoids a circular dependency: ProcessEmail already requires
      // this module for notifyUnreadEmail, so loading it here (after startup)
      // is safe and keeps the load-time cycle from breaking that export.
      const { getAttachment } = require("../Mail/ProcessEmail.js");
      const result = await getAttachment(email, id);
      if (!result) {
        ws.send(
          JSON.stringify({ type: "get_attachment", ok: false, id, error: "Not found" })
        );
        return;
      }
      ws.send(JSON.stringify({ type: "get_attachment", ok: true, ...result }));
    } catch (err) {
      console.error("Failed to fetch attachment:", err);
      ws.send(
        JSON.stringify({ type: "get_attachment", ok: false, id, error: "Fetch failed" })
      );
    }
  } else if (msg.type === "claim_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    let email = messageId ? mailStore.get(messageId) : null;
    if (!email && messageId && msg.restore === true) {
      // A worker reconnected with this email's form still open, but the
      // server no longer holds it (e.g. it restarted, wiping the in-memory
      // store; the email is read in Gmail, so polling will not bring it back).
      // Reload it straight from Gmail so the worker can keep working on it.
      try {
        email = await restoreEmail(messageId);
      } catch (err) {
        console.error("Failed to restore email for reconnecting worker:", err);
      }
    }
    if (!email) {
      ws.send(
        JSON.stringify({
          type: "claim_email",
          ok: false,
          messageId,
          error: "Not found",
        })
      );
      return;
    }
    if (!canSeeEmail(ws.branch, email)) {
      ws.send(
        JSON.stringify({
          type: "claim_email",
          ok: false,
          messageId,
          error: "Not found",
        })
      );
      return;
    }
    const ok = mailStore.claim(messageId, ws.username);
    if (ok) {
      // The claim now belongs to this connection only. This matters after a
      // reconnect: the server may notice the old, dead connection only later
      // (heartbeat), and its close handler must not release the email the
      // worker has just re-claimed here.
      for (const client of wss.clients) {
        if (client !== ws && client.claimedEmails) {
          client.claimedEmails.delete(messageId);
        }
      }
      ws.claimedEmails.add(messageId);
      broadcast({ type: "email_claimed", messageId }, email);
    }
    ws.send(JSON.stringify({ type: "claim_email", ok, messageId }));
    if (ok) {
      // Opened (or re-opened after a reconnect) by a worker: mark it read.
      try {
        await mailStore.syncReadState(email.account, messageId);
      } catch (err) {
        console.error("Failed to mark claimed email as read:", err);
      }
    }
  } else if (msg.type === "release_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const releasable = messageId ? mailStore.get(messageId) : null;
    if (releasable && !canSeeEmail(ws.branch, releasable)) return;
    const claimer = mailStore.getClaimer(messageId);
    // Only the worker that holds the claim may return it to everyone. Carry
    // the full email so clients without it can reconstruct the card.
    if (!claimer || claimer === ws.username) {
      mailStore.unclaim(messageId);
      ws.claimedEmails.delete(messageId);
      if (claimer === ws.username) {
        const email = mailStore.get(messageId);
        // The worker cancelled (went back to the dashboard).
        if (email) await releaseEmail(email, messageId);
      }
    }
  } else if (msg.type === "complete_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const email = messageId ? mailStore.get(messageId) : null;
    if (!email) return;
    if (!canSeeEmail(ws.branch, email)) return;

    mailStore.remove(messageId);
    ws.claimedEmails.delete(messageId);
    // Only now mark the Gmail message read (the worker finished the form).
    // Pass the account so the correct inbox's API client is used.
    // Queued behind any pending "mark unread" (e.g. from a dropped
    // connection), so the email always ends up read.
    try {
      await mailStore.syncReadState(email.account, messageId);
    } catch (err) {
      console.error("Failed to mark email as read:", err);
    }
    broadcast({ type: "email_completed", messageId }, email);
  } else if (msg.type === "mark_irrelevant") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const email = messageId ? mailStore.get(messageId) : null;
    if (!email) return;
    if (!canSeeEmail(ws.branch, email)) return;

    // Dismissed as irrelevant: drop it from the shared pool and mark the Gmail
    // message read so it never re-surfaces on a later poll or server restart.
    mailStore.remove(messageId);
    ws.claimedEmails.delete(messageId);
    try {
      await mailStore.syncReadState(email.account, messageId);
    } catch (err) {
      console.error("Failed to mark irrelevant email as read:", err);
    }
    broadcast({ type: "email_irrelevant", messageId }, email);
  }
}

/**
 * Send a "new email" notification only to connected, authenticated clients
 * whose user account has the designated role.
 *
 * @param {Object} emailInfo  Details about the unread email.
 * @returns {number} Number of clients the notification was delivered to.
 */
module.exports.notifyUnreadEmail = function notifyUnreadEmail(emailInfo) {
  return broadcast({ type: "new_email", data: emailInfo }, emailInfo);
};

/**
 * Tell workers that an email was read in Gmail outside of this app, so its
 * card must be removed from their dashboards.
 *
 * @param {Object} emailInfo  The email that is no longer unread.
 * @returns {number} Number of clients the notification was delivered to.
 */
module.exports.notifyEmailRead = function notifyEmailRead(emailInfo) {
  return broadcast(
    { type: "email_read", messageId: emailInfo.messageId },
    emailInfo
  );
};

/**
 * Send a payload to every connected, authenticated client belonging to the
 * designated email-update role.
 *
 * @param {Object} payload  Message to deliver to workers.
 * @param {Object} [email]  When given, only workers whose branch is allowed to
 *   see this email (see Mail/branchRouting.js) receive the payload.
 * @returns {number} Number of clients the notification was delivered to.
 */
function broadcast(payload, email) {
  if (!wss) return 0;

  let delivered = 0;
  const message =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.username &&
      String(client.role) === EMAIL_UPDATE_ROLE &&
      (!email || canSeeEmail(client.branch, email))
    ) {
      try {
        client.send(message);
        delivered++;
      } catch (err) {
        console.error("Failed to broadcast email update to a client:", err);
      }
    }
  }

  return delivered;
}

/**
 * Send an arbitrary payload to all connected sockets belonging to a specific
 * logged-in user.
 *
 * @param {string} username  Target username.
 * @param {*} [payload]  Data to send (object or string).
 * @returns {number} Number of clients the payload was delivered to.
 */
module.exports.sendToUser = function sendToUser(username, payload) {
  if (!wss) return 0;

  const message =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  let delivered = 0;

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      try {
        client.send(message);
        delivered++;
      } catch (err) {
        console.error("Failed to send WebSocket message to a user:", err);
      }
    }
  }

  return delivered;
};

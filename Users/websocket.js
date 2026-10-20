const { WebSocketServer, WebSocket } = require("ws");
const mailStore = require("../Mail/mailStore.js");
const { canSeeEmail, extractAddress } = require("../Mail/branchRouting.js");

function checkCutOffSender(from) {
  const { isCutOffBrokerSender } = require("../Mail/brokerSenders.js");
  return isCutOffBrokerSender(from);
}

let wss = null;
let db = null;

// Only clients whose user account has this role receive email updates.
const EMAIL_UPDATE_ROLE = "2";

// How long a dropped connection's claimed emails stay reserved before they are
// returned to the pool (and marked unread), giving the worker time to
// reconnect or the next page time to claim the email on a slow/unstable link.
const RELEASE_GRACE_MS = Number(process.env.EMAIL_RELEASE_GRACE_MS) || 15000;

// Pending release timers keyed by messageId so re-claiming (or a second drop)
// cancels/resets any earlier timer instead of releasing prematurely.
const pendingReleaseTimers = new Map();

function clearPendingRelease(messageId) {
  if (!messageId) return;
  const timer = pendingReleaseTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    pendingReleaseTimers.delete(messageId);
  }
}

// ---------------------------------------------------------------------------
// Worker presence board.
//
// A worker is "online" while they hold at least one authenticated WebSocket.
// Their status is one of:
//   "online"  (green)  online and on the PC
//   "working" (orange) busy working on a form
//   "afk"     (red)    online but away from keyboard
// The afk threshold is enforced client-side; this module only stores and
// re-broadcasts the status it is told.
// ---------------------------------------------------------------------------

// Role whose members appear on the presence board.
const PRESENCE_ROLE = "2";

// Roles allowed to see the board (admins + workers).
const PRESENCE_VIEWER_ROLES = new Set(["1", "2"]);

// After the last connection of a worker closes, wait this long before declaring
// them offline. This absorbs the socket swap when the client navigates
// dashboard -> form -> dashboard or reconnects over a slow link, so the board
// does not flicker.
const PRESENCE_OFFLINE_GRACE_MS =
  Number(process.env.PRESENCE_OFFLINE_GRACE_MS) || 8000;

// Pending offline timers keyed by username.
const pendingPresenceTimers = new Map();

function clearPendingPresenceOffline(username) {
  if (!username) return;
  const timer = pendingPresenceTimers.get(username);
  if (timer) {
    clearTimeout(timer);
    pendingPresenceTimers.delete(username);
  }
}

// Valid statuses a worker may report.
const PRESENCE_STATUSES = new Set(["online", "working", "afk"]);

// username -> { username, status: "online" | "working" | "afk", updatedAt }
const presence = new Map();

function isWorkerConnected(username) {
  if (!wss || !username) return false;
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.username === username &&
      String(client.role) === PRESENCE_ROLE
    ) {
      return true;
    }
  }
  return false;
}

function onlineWorkers() {
  return Array.from(presence.values())
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function broadcastPresence() {
  if (!wss) return;
  const message = JSON.stringify({
    type: "presence_update",
    data: onlineWorkers(),
  });
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.username &&
      PRESENCE_VIEWER_ROLES.has(String(client.role))
    ) {
      try {
        client.send(message);
      } catch (err) {
        console.error("Failed to broadcast presence update:", err);
      }
    }
  }
}

function ensureWorkerOnline(username) {
  clearPendingPresenceOffline(username);
  if (presence.has(username)) return;
  presence.set(username, { username, status: "online", updatedAt: Date.now() });
  broadcastPresence();
}

function setWorkerPresence(ws, status) {
  if (!ws.username || String(ws.role) !== PRESENCE_ROLE) return;
  clearPendingPresenceOffline(ws.username);
  const normalized = PRESENCE_STATUSES.has(status) ? status : "online";
  const existing = presence.get(ws.username);
  if (existing && existing.status === normalized) {
    // Same status: only refresh the heartbeat timestamp, don't re-broadcast.
    existing.updatedAt = Date.now();
    return;
  }
  presence.set(ws.username, {
    username: ws.username,
    status: normalized,
    updatedAt: Date.now(),
  });
  broadcastPresence();
}

function removeWorkerPresence(username) {
  clearPendingPresenceOffline(username);
  if (!username || isWorkerConnected(username)) return;
  if (presence.delete(username)) broadcastPresence();
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    const message =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    ws.send(message);
    return true;
  } catch (err) {
    console.error("Failed to send WebSocket message:", err);
    return false;
  }
}

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
  wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
    },
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", (err) => {
      console.warn(
        "WebSocket upgrade socket error:",
        err && err.message ? err.message : err
      );
    });

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
    ws.lastBufferedAmount = 0;
    ws.stalledTicks = 0;
    // Email cards claimed through this specific connection. Used to release
    // them if the worker client drops (power loss / network failure) so other
    // workers can pick them up again.
    ws.claimedEmails = new Set();

    ws.on("error", (err) => {
      console.warn(
        "WebSocket client error:",
        err && err.message ? err.message : err
      );
    });

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.stalledTicks = 0;
    });

    ws.on("message", (data) => {
      // Any incoming frame proves the client connection is alive.
      ws.isAlive = true;
      ws.stalledTicks = 0;
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
      const username = ws.username;
      const claimed = Array.from(ws.claimedEmails);
      ws.claimedEmails.clear();
      if (claimed.length > 0) {
        for (const messageId of claimed) {
          clearPendingRelease(messageId);
          const timer = setTimeout(() => {
            pendingReleaseTimers.delete(messageId);
            const email = mailStore.get(messageId);
            if (!email) return;
            // Only release if this user still holds the claim and has not
            // re-claimed it on a newer connection in the meantime. The card may
            // also have been released/completed and claimed by someone else.
            if (mailStore.getClaimer(messageId) !== username) return;
            if (isHeldByOpenConnection(messageId)) return;
            releaseEmail(email, messageId).catch((err) => {
              console.error("Failed to release email of closed connection:", err);
            });
          }, RELEASE_GRACE_MS);
          if (typeof timer.unref === "function") timer.unref();
          pendingReleaseTimers.set(messageId, timer);
        }
      }

      // Remove the worker from the presence board once no other authenticated
      // connection remains (see PRESENCE_OFFLINE_GRACE_MS).
      if (username && String(ws.role) === PRESENCE_ROLE) {
        clearPendingPresenceOffline(username);
        const timer = setTimeout(
          () => removeWorkerPresence(username),
          PRESENCE_OFFLINE_GRACE_MS
        );
        if (typeof timer.unref === "function") timer.unref();
        pendingPresenceTimers.set(username, timer);
      }
    });
  });

  // Heartbeat to drop dead connections from Electron clients.
  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      try {
        if (client.isAlive === false) {
          // When a large payload (e.g. a multi-MB attachment) is still queued
          // in the outgoing socket buffer over a slow link, the server's ping
          // frame sits behind it and cannot reach the client yet. As long as
          // the buffer is draining (or has only been full for a few ticks),
          // keep the connection alive instead of killing the transfer.
          const buffered = client.bufferedAmount || 0;
          if (buffered > 0) {
            const draining =
              client.lastBufferedAmount === 0 ||
              buffered < client.lastBufferedAmount;
            client.lastBufferedAmount = buffered;
            client.stalledTicks = draining ? 0 : (client.stalledTicks || 0) + 1;
            if (client.stalledTicks <= 3) {
              continue;
            }
          }
          client.terminate();
          continue;
        }
        client.lastBufferedAmount = client.bufferedAmount || 0;
        client.stalledTicks = 0;
        client.isAlive = false;
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
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
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

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
  if (await checkCutOffSender(email.from)) {
    mailStore.evict(messageId);
    module.exports.notifyEmailRead(email);
    try {
      await mailStore.markUnread(email.account, messageId);
    } catch (err) {
      console.error("Failed to mark cut-off broker email as unread:", err);
    }
    return;
  }
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
        // Register the worker on the presence board (unless they are already
        // online from a connection still within its offline grace period).
        if (String(ws.role) === PRESENCE_ROLE) {
          ensureWorkerOnline(username);
        }
        safeSend(ws, { type: "auth_ok", username });
      } else {
        safeSend(ws, {
          type: "auth_error",
          error: "Invalid or expired token",
        });
      }
    } catch (err) {
      console.error("WebSocket auth error:", err);
      // Database/transient error: close the socket so the client reconnects
      // with backoff instead of treating its token as invalid and logging out.
      try {
        ws.close(1013, "Try again later");
      } catch {
        // ignore
      }
    }
  } else if (msg.type === "ping") {
    safeSend(ws, { type: "pong", ts: msg.ts });
  } else if (msg.type === "presence") {
    setWorkerPresence(ws, msg.status);
  } else if (msg.type === "list_presence") {
    if (!ws.username) return;
    safeSend(ws, { type: "presence_update", data: onlineWorkers() });
  } else if (msg.type === "list_emails") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      safeSend(ws, { type: "list_emails", data: [] });
      return;
    }
    const candidates = mailStore
      .listAll()
      .filter((email) => canSeeEmail(ws.branch, email));
    const data = [];
    for (const email of candidates) {
      if (await checkCutOffSender(email.from)) {
        mailStore.evict(email.messageId);
        continue;
      }
      data.push(email);
    }
    safeSend(ws, { type: "list_emails", data });
  } else if (msg.type === "get_attachment") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const id = msg.id || null;
    const email = messageId ? mailStore.get(messageId) : null;
    if (
      !email ||
      !id ||
      !canSeeEmail(ws.branch, email) ||
      (await checkCutOffSender(email.from))
    ) {
      safeSend(ws, {
        type: "get_attachment",
        ok: false,
        id,
        error: "Not found",
      });
      return;
    }
    try {
      // Lazy require avoids a circular dependency: ProcessEmail already requires
      // this module for notifyUnreadEmail, so loading it here (after startup)
      // is safe and keeps the load-time cycle from breaking that export.
      const { getAttachment } = require("../Mail/ProcessEmail.js");
      const result = await getAttachment(email, id);
      if (!result) {
        safeSend(ws, {
          type: "get_attachment",
          ok: false,
          id,
          error: "Not found",
        });
        return;
      }
      safeSend(ws, { type: "get_attachment", ok: true, ...result });
    } catch (err) {
      console.error("Failed to fetch attachment:", err);
      safeSend(ws, {
        type: "get_attachment",
        ok: false,
        id,
        error: "Fetch failed",
      });
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
      safeSend(ws, {
        type: "claim_email",
        ok: false,
        messageId,
        error: "Not found",
      });
      return;
    }
    if (!canSeeEmail(ws.branch, email) || (await checkCutOffSender(email.from))) {
      if (await checkCutOffSender(email.from)) {
        mailStore.evict(messageId);
      }
      safeSend(ws, {
        type: "claim_email",
        ok: false,
        messageId,
        error: "Not found",
      });
      return;
    }
    const ok = mailStore.claim(messageId, ws.username);
    if (ok) {
      clearPendingRelease(messageId);
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
    safeSend(ws, { type: "claim_email", ok, messageId });
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
    clearPendingRelease(messageId);
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
    clearPendingRelease(messageId);
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
    clearPendingRelease(messageId);
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
 * Evict every stored email whose sender matches one of `addresses` (e.g. when a
 * broker is cut off) and notify connected workers so their cards disappear
 * immediately.
 *
 * @param {Iterable<string>} addresses
 */
module.exports.evictEmailsForAddresses = async function evictEmailsForAddresses(
  addresses
) {
  const targetSet = new Set();
  for (const addr of addresses || []) {
    const normalized = extractAddress(addr);
    if (normalized) targetSet.add(normalized);
  }
  if (targetSet.size === 0) return;

  for (const { email } of mailStore.listAllEntries()) {
    const sender = extractAddress(email.from);
    if (!sender || !targetSet.has(sender)) continue;

    clearPendingRelease(email.messageId);
    if (wss) {
      for (const client of wss.clients) {
        if (client.claimedEmails) {
          client.claimedEmails.delete(email.messageId);
        }
      }
    }
    const evicted = mailStore.evict(email.messageId);
    module.exports.notifyEmailRead(email);
    if (evicted && evicted.wasClaimed) {
      try {
        await mailStore.markUnread(email.account, email.messageId);
      } catch (err) {
        console.error(
          `Failed to mark evicted email "${email.messageId}" as unread:`,
          err
        );
      }
    }
  }
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

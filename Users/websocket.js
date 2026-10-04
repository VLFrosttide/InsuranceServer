const { WebSocketServer, WebSocket } = require("ws");
const mailStore = require("../Mail/mailStore.js");

let wss = null;
let db = null;

// Only clients whose user account has this role receive email updates.
const EMAIL_UPDATE_ROLE = "2";

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
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.username = null;
    ws.role = null;
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data) => handleMessage(ws, data));

    ws.on("close", () => {
      // Socket cleanup is implicit; the client set is maintained by `ws`.
    });
  });

  // Heartbeat to drop dead connections from Electron clients.
  setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);

  return wss;
};

async function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
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
    const data = mailStore.listAll();
    ws.send(JSON.stringify({ type: "list_emails", data }));
  } else if (msg.type === "claim_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const email = messageId ? mailStore.get(messageId) : null;
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
    const ok = mailStore.claim(messageId, ws.username);
    if (ok) {
      broadcast({ type: "email_claimed", messageId });
    }
    ws.send(JSON.stringify({ type: "claim_email", ok, messageId }));
  } else if (msg.type === "release_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const claimer = mailStore.getClaimer(messageId);
    // Only the worker that holds the claim may return it to everyone. Carry
    // the full email so clients without it can reconstruct the card.
    if (!claimer || claimer === ws.username) {
      mailStore.unclaim(messageId);
      if (claimer === ws.username) {
        const email = mailStore.get(messageId);
        if (email) broadcast({ type: "email_released", data: email });
      }
    }
  } else if (msg.type === "complete_email") {
    if (!ws.username || String(ws.role) !== EMAIL_UPDATE_ROLE) {
      return;
    }
    const messageId = msg.messageId || null;
    const email = messageId ? mailStore.get(messageId) : null;
    if (!email) return;

    mailStore.remove(messageId);
    // Only now mark the Gmail message read (the worker finished the form).
    // Pass the account so the correct inbox's API client is used.
    try {
      await mailStore.markRead(email.account, messageId);
    } catch (err) {
      console.error("Failed to mark email as read:", err);
    }
    broadcast({ type: "email_completed", messageId });
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
  return broadcast({ type: "new_email", data: emailInfo });
};

/**
 * Send a payload to every connected, authenticated client belonging to the
 * designated email-update role.
 *
 * @param {Object} payload  Message to deliver to workers.
 * @returns {number} Number of clients the notification was delivered to.
 */
function broadcast(payload) {
  if (!wss) return 0;

  let delivered = 0;
  const message =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.username &&
      String(client.role) === EMAIL_UPDATE_ROLE
    ) {
      client.send(message);
      delivered++;
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
      client.send(message);
      delivered++;
    }
  }

  return delivered;
};

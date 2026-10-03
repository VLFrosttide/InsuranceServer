"use strict";
// Test/demo endpoints used to exercise the system without real Gmail data.
//
// - POST /test/email      Inject a dummy unread email into the mail store and
//                         broadcast it to connected workers, exactly like the
//                         Gmail polling pipeline does for a real message.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const mailStore = require("../Mail/mailStore.js");
const { notifyUnreadEmail } = require("../Users/websocket.js");

/**
 * Create the test router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createTestRouter = function createTestRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  // Simulate a real email arriving for the worker workflow. The dummy message
  // is stored as an unclaimed email and broadcast through the same code path
  // used by ProcessEmail.js (mailStore.add + notifyUnreadEmail), so workers
  // see a normal unread card and can claim/open/complete it.
  router.post("/test/email", auth, requireRole(2), async (req, res) => {
    try {
      const now = new Date();
      const unique = `${now.getTime()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const email = {
        account: req.body?.account || "TestAccount",
        messageId: `test-${unique}`,
        from: req.body?.from || "test@insurance.example",
        subject: req.body?.subject || `Test email ${now.toISOString()}`,
        date: now.toString(),
        body:
          req.body?.body ||
          "This is a simulated incoming email.\n\n" +
            "It was injected by the Test button to exercise the worker workflow " +
            "without waiting for a real Gmail message.",
        attachments: [],
      };

      mailStore.add(email);
      notifyUnreadEmail(email);

      res.status(201).json({ message: "Test email injected", email });
    } catch (err) {
      console.error("Test email injection failed:", err);
      res.status(500).json({ error: "Failed to inject test email" });
    }
  });

  return router;
};

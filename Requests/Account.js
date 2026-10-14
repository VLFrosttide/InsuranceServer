"use strict";
// Account settings for the logged-in user.
//
// - GET  /account            — the caller's profile plus, for broker accounts,
//                              the emails associated with their broker.
// - POST /account/password   — change the caller's own password.
// - PUT  /account/emails     — replace the emails associated with the caller's
//                              broker (broker/role-3 accounts only).
const express = require("express");
const Bcrypt = require("bcryptjs");
const { requireAuth } = require("./Auth.js");

/**
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createAccountRouter = function createAccountRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  router.get("/account", auth, async (req, res) => {
    try {
      const [[user]] = await DBConnection.query(
        "SELECT Username, Role, Status, BrokerId, Email FROM users WHERE Username = ?",
        [req.user.username]
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const payload = {
        username: user.Username,
        role: String(user.Role),
        status: user.Status,
        brokerId: user.BrokerId ?? null,
        email: user.Email ?? null,
        brokerName: null,
        emails: [],
        canManageEmails: false,
      };

      if (user.BrokerId) {
        const [[broker]] = await DBConnection.query(
          "SELECT Name FROM brokers WHERE id = ?",
          [user.BrokerId]
        );
        payload.brokerName = broker ? broker.Name : null;
        const [emails] = await DBConnection.query(
          "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
          [user.BrokerId]
        );
        payload.emails = emails.map((r) => r.Email);
        // Only broker (role 3) logins may edit their broker's email list.
        payload.canManageEmails = String(user.Role) === "3";
      }

      res.json(payload);
    } catch (err) {
      console.error("Account lookup failed:", err);
      res.status(500).json({ error: "Failed to load account" });
    }
  });

  router.post("/account/password", auth, async (req, res) => {
    try {
      const currentPassword = req.body?.currentPassword ?? "";
      const newPassword = req.body?.newPassword ?? "";

      if (!currentPassword || !newPassword) {
        return res
          .status(400)
          .json({ error: "Current and new password are required" });
      }
      if (typeof newPassword !== "string" || newPassword.length < 6) {
        return res
          .status(400)
          .json({ error: "New password must be at least 6 characters" });
      }

      const [[user]] = await DBConnection.query(
        "SELECT Password FROM users WHERE Username = ?",
        [req.user.username]
      );
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const matches = await Bcrypt.compare(currentPassword, user.Password);
      if (!matches) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }

      const hash = await Bcrypt.hash(newPassword, 12);
      await DBConnection.query(
        "UPDATE users SET Password = ? WHERE Username = ?",
        [hash, req.user.username]
      );

      res.json({ message: "Password changed" });
    } catch (err) {
      console.error("Password change failed:", err);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  router.put("/account/emails", auth, async (req, res) => {
    try {
      if (String(req.user.role) !== "3" || !req.user.brokerId) {
        return res
          .status(403)
          .json({ error: "Only broker accounts can manage emails" });
      }

      const brokerId = Number(req.user.brokerId);
      const raw = req.body?.emails;
      const emails = (Array.isArray(raw) ? raw : [raw])
        .map((e) => String(e ?? "").trim())
        .filter((e) => e.length > 0);

      await DBConnection.withTransaction(async (conn) => {
        await conn.query("DELETE FROM broker_emails WHERE BrokerId = ?", [
          brokerId,
        ]);
        for (const email of emails) {
          await conn.query(
            "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
            [brokerId, email]
          );
        }
      });

      const [rows] = await DBConnection.query(
        "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
        [brokerId]
      );

      res.json({
        message: "Emails updated",
        emails: rows.map((r) => r.Email),
      });
    } catch (err) {
      console.error("Email update failed:", err);
      res.status(500).json({ error: "Failed to update emails" });
    }
  });

  return router;
};

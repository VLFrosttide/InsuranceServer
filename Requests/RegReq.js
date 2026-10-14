"use strict";
// Self-service registration. Anyone can create a "client" (role 3) account,
// but the account starts in a "pending" state and is NOT usable until an admin
// approves it and binds it to a broker (see /admin/users/:username/approve).
// Admin/worker accounts are seeded via db/setup.js (or created at the DB).
const express = require("express");
const Bcrypt = require("bcryptjs");

/**
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createRegRouter = function createRegRouter(DBConnection) {
  const router = express.Router();

  router.post("/userreg", async (req, res) => {
    try {
      const Username = String(
        req.body.username ?? req.body.Username ?? ""
      ).trim();
      const Password = req.body.password ?? req.body.Password;
      const Email = String(req.body.email ?? req.body.Email ?? "").trim();

      if (!Username || !Password) {
        return res
          .status(400)
          .json({ error: "Username and Password are required" });
      }

      if (typeof Username !== "string" || Username.length < 2) {
        return res
          .status(400)
          .json({ error: "Username must be at least 2 characters" });
      }

      if (typeof Password !== "string" || Password.length < 6) {
        return res
          .status(400)
          .json({ error: "Password must be at least 6 characters" });
      }

      const [existing] = await DBConnection.query(
        "SELECT Username FROM users WHERE Username = ?",
        [Username]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: "Username already exists" });
      }

      const PassHash = await Bcrypt.hash(Password, 12);
      // Registration is always a client (role 3) account. It is created in a
      // pending state: an admin must approve and broker-link it before login.
      await DBConnection.query(
        "INSERT INTO users (Username, Password, Role, Balance, Status, Email) VALUES (?, ?, 3, 0, 'pending', ?)",
        [Username, PassHash, Email || null]
      );

      return res.status(201).json({
        message:
          "Registration submitted. It will become active once an admin approves it.",
        username: Username,
        status: "pending",
      });
    } catch (err) {
      console.error("Registration failed:", err);
      return res.status(500).json({ error: "Registration failed" });
    }
  });

  return router;
};


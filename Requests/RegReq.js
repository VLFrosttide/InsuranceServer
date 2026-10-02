"use strict";
// Self-service registration. Anyone can create a "client" (role 3) account.
// Admin/worker accounts are seeded via db/setup.js (or created at the DB).
const express = require("express");
const Bcrypt = require("bcrypt");

const VALID_ROLES = new Set(["1", "2", "3"]);

/**
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createRegRouter = function createRegRouter(DBConnection) {
  const router = express.Router();

  router.post("/userreg", async (req, res) => {
    try {
      const Username = req.body.username ?? req.body.Username;
      const Password = req.body.password ?? req.body.Password;
      const RoleID = req.body.role ?? req.body.RoleID ?? "3";

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

      const role = String(RoleID);
      if (!VALID_ROLES.has(role)) {
        return res.status(400).json({
          error: "RoleID must be one of 1 (admin), 2 (worker), 3 (client)",
        });
      }

      const [existing] = await DBConnection.query(
        "SELECT Username FROM Users WHERE Username = ?",
        [Username]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: "Username already exists" });
      }

      const PassHash = await Bcrypt.hash(Password, 12);
      await DBConnection.query(
        "INSERT INTO Users (Username, Password, Role, Balance) VALUES (?, ?, ?, 0)",
        [Username, PassHash, Number(role)]
      );

      return res.status(201).json({
        message: "User Created",
        username: Username,
        role,
      });
    } catch (err) {
      console.error("Registration failed:", err);
      return res.status(500).json({ error: "Registration failed" });
    }
  });

  return router;
};

"use strict";
// Role-specific (tiered) protected endpoints.
//
// User roles in the database:
//   1 = admin
//   2 = worker
//   3 = client
//
// Every route below is protected by `requireAuth` and further restricted with
// `requireRole`, so a user can only reach endpoints matching their tier.

import express from "express";
import { requireAuth, requireRole } from "./Auth.js";

/**
 * Parse a human/duration value into an integer number of days.
 * Accepts "15", "15 дена", "3 месеца", "1 година", etc.
 */
function parseDurationDays(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const str = String(value).toLowerCase();
  const num = parseInt(str.replace(/[^0-9]/g, ""), 10);
  if (Number.isNaN(num)) return 0;
  if (str.includes("годин") || str.includes("year")) return num * 365;
  if (str.includes("месец") || str.includes("month")) return num * 30;
  return num; // days
}

/**
 * Create the tiered router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
export function createTierRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  // ---------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------
  router.get("/health", (req, res) => {
    res.json({ status: "ok", service: "InsuranceServer" });
  });

  // ---------------------------------------------------------------------
  // Admin tier (role 1)
  // ---------------------------------------------------------------------
  router.get("/admin", auth, requireRole(1), (req, res) => {
    res.json({
      tier: "admin",
      message: "Welcome to the admin panel",
      user: req.user,
    });
  });

  router.get("/admin/users", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT Username, Role, Balance, PayoutPercentage FROM Users"
      );
      res.json({ users: rows });
    } catch (err) {
      console.error("Admin users lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  router.get("/admin/stats", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT
           SUM(Role = 1) AS admins,
           SUM(Role = 2) AS workers,
           SUM(Role = 3) AS clients,
           COUNT(*) AS total
         FROM Users`
      );
      res.json({ stats: rows[0] || {} });
    } catch (err) {
      console.error("Admin stats lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  router.get("/admin/insurances", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query("SELECT * FROM insurance");
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Admin insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  router.patch(
    "/admin/users/:username",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { username } = req.params;
        const { role, balance, payoutPercentage } = req.body;

        const [existing] = await DBConnection.query(
          "SELECT Username FROM Users WHERE Username = ?",
          [username]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        const sets = [];
        const params = [];
        if (role !== undefined) {
          const r = Number(role);
          if (![1, 2, 3].includes(r)) {
            return res.status(400).json({ error: "role must be 1, 2 or 3" });
          }
          sets.push("Role = ?");
          params.push(r);
        }
        if (balance !== undefined) {
          const b = Number(balance);
          if (!Number.isFinite(b) || b < 0) {
            return res
              .status(400)
              .json({ error: "balance must be a non-negative number" });
          }
          sets.push("Balance = ?");
          params.push(b);
        }
        if (payoutPercentage !== undefined) {
          const p = Number(payoutPercentage);
          if (!Number.isFinite(p) || p < 0 || p > 100) {
            return res
              .status(400)
              .json({ error: "payoutPercentage must be between 0 and 100" });
          }
          sets.push("PayoutPercentage = ?");
          params.push(p);
        }

        if (sets.length === 0) {
          return res.status(400).json({ error: "Nothing to update" });
        }

        params.push(username);
        await DBConnection.query(
          `UPDATE Users SET ${sets.join(", ")} WHERE Username = ?`,
          params
        );

        const [rows] = await DBConnection.query(
          "SELECT Username, Role, Balance, PayoutPercentage FROM Users WHERE Username = ?",
          [username]
        );
        res.json({ message: "User updated", user: rows[0] });
      } catch (err) {
        console.error("Admin user update failed:", err);
        res.status(500).json({ error: "Failed to update user" });
      }
    }
  );

  // ---------------------------------------------------------------------
  // Worker tier (role 2)
  // ---------------------------------------------------------------------
  router.get("/worker", auth, requireRole(2), (req, res) => {
    res.json({
      tier: "worker",
      message: "Welcome to the worker dashboard",
      user: req.user,
    });
  });

  router.get("/worker/tasks", auth, requireRole(2), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT * FROM tasks WHERE Assignee = ?",
        [req.user.username]
      );
      res.json({ tasks: rows });
    } catch (err) {
      console.error("Worker tasks lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  router.get("/worker/clients", auth, requireRole(2), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT Username, Balance, PayoutPercentage FROM Users WHERE Role = 3"
      );
      res.json({ clients: rows });
    } catch (err) {
      console.error("Worker clients lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  router.post(
    "/worker/clients/balance",
    auth,
    requireRole(2),
    async (req, res) => {
      try {
        const { username, balance } = req.body;

        if (!username || balance === undefined) {
          return res
            .status(400)
            .json({ error: "username and balance are required" });
        }

        if (
          typeof balance !== "number" ||
          !Number.isFinite(balance) ||
          balance < 0
        ) {
          return res
            .status(400)
            .json({ error: "balance must be a non-negative number" });
        }

        const [result] = await DBConnection.query(
          "UPDATE Users SET Balance = ? WHERE Username = ? AND Role = 3",
          [balance, username]
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Client not found" });
        }

        res.json({ message: "Balance updated", username, balance });
      } catch (err) {
        console.error("Worker balance update failed:", err);
        res.status(500).json({ error: "Failed to update balance" });
      }
    }
  );

  router.post("/worker/insurances", auth, requireRole(2), async (req, res) => {
    try {
      const b = req.body || {};
      const dkn = b.DKN ?? b.dkn ?? "";
      const policyNumber = b.PolicyNumber ?? b.policyNumber ?? "";
      const blancNumber = b.BlancNumber ?? b.blancNumber ?? "";
      const price = String(b.Price ?? b.price ?? "0");
      const currencyType = b.CurrencyType ?? b.currencyType ?? "";
      const duration = parseDurationDays(b.Duration ?? b.duration ?? 0);
      const brokerCode = b.BrokerCode ?? b.brokerCode ?? "";
      const branch = b.Branch ?? b.branch ?? "";
      const otomobil = b.Otomobil ?? b.otomobil ?? "";
      const cash = String(b.Cash ?? b.cash ?? "false");
      const clientName = b.ClientName ?? b.clientName ?? "";
      const clientAdress = b.ClientAdress ?? b.clientAdress ?? "";
      const chassisNumber = b.ChassisNumber ?? b.chassisNumber ?? "";
      const vehicleBrand = b.VehicleBrand ?? b.vehicleBrand ?? "";
      const broker = b.Broker ?? b.broker ?? req.user.username;

      if (!blancNumber) {
        return res.status(400).json({ error: "BlancNumber is required" });
      }
      if (!clientName) {
        return res.status(400).json({ error: "ClientName is required" });
      }

      // VehicleBrand column is optional (added by db/setup.js); guard old DBs.
      const [cols] = await DBConnection.query("SHOW COLUMNS FROM insurance");
      const hasVehicleBrand = cols.some((c) => c.Field === "VehicleBrand");

      let sql, params;
      if (hasVehicleBrand) {
        sql = `INSERT INTO insurance
            (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price,
             CurrencyType, Duration, BrokerCode, Branch, Otomobil, Cash,
             ClientName, ClientAdress, ChassisNumber, VehicleBrand, Broker)
           VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          req.user.username,
          dkn,
          policyNumber,
          blancNumber,
          price,
          currencyType,
          duration,
          brokerCode,
          branch,
          otomobil,
          cash,
          clientName,
          clientAdress,
          chassisNumber,
          vehicleBrand,
          broker,
        ];
      } else {
        sql = `INSERT INTO insurance
            (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price,
             CurrencyType, Duration, BrokerCode, Branch, Otomobil, Cash,
             ClientName, ClientAdress, ChassisNumber, Broker)
           VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          req.user.username,
          dkn,
          policyNumber,
          blancNumber,
          price,
          currencyType,
          duration,
          brokerCode,
          branch,
          otomobil,
          cash,
          clientName,
          clientAdress,
          chassisNumber,
          broker,
        ];
      }

      await DBConnection.query(sql, params);
      res.status(201).json({
        message: "Insurance created",
        blancNumber,
        author: req.user.username,
      });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: "Insurance with this BlancNumber already exists" });
      }
      console.error("Worker insurance create failed:", err);
      res.status(500).json({ error: "Failed to create insurance" });
    }
  });

  // ---------------------------------------------------------------------
  // Client tier (role 3)
  // ---------------------------------------------------------------------
  router.get("/client", auth, requireRole(3), (req, res) => {
    res.json({
      tier: "client",
      message: "Welcome to the client portal",
      user: req.user,
    });
  });

  router.get("/client/profile", auth, requireRole(3), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT Username, Role, Balance, PayoutPercentage FROM Users WHERE Username = ?",
        [req.user.username]
      );
      res.json({ profile: rows[0] || null });
    } catch (err) {
      console.error("Client profile lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  router.get("/client/insurances", auth, requireRole(3), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT * FROM insurance WHERE Broker = ?",
        [req.user.username]
      );
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Client insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  return router;
}

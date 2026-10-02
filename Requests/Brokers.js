"use strict";
// Broker balance support.
//
// Each broker has a cash balance that only admins (role 1) and workers
// (role 2) can increase/reduce. Unlike daily current cash, a broker balance
// may go negative.
//
// Creating an insurance reduces its broker's balance by
//   policy price × broker.Percentage / 100
// and decrements the broker's InactivePolicies by 1.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { toDecimal } = require("./CurrentCash.js");

/**
 * Parse and validate a positive amount (returns null when invalid).
 * @param {number|string} value
 * @returns {number|null}
 */
function parsePositiveAmount(value) {
  const n = toDecimal(value);
  if (n === null || n <= 0) return null;
  return n;
}

/**
 * Resolve the broker that an insurance belongs to.
 *
 * Order of resolution:
 *   1. An explicit BrokerId.
 *   2. A broker whose policy range contains the blanc number.
 *   3. The single broker, if exactly one exists.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {{blancNumber?: any, brokerId?: any}} insurance
 * @returns {Promise<number|null>}
 */
const resolveBrokerId = (module.exports.resolveBrokerId =
  async function resolveBrokerId(conn, insurance = {}) {
    const { blancNumber, brokerId } = insurance;

    if (brokerId !== undefined && brokerId !== null && brokerId !== "") {
      const id = Number(brokerId);
      if (Number.isFinite(id) && id > 0) {
        const [rows] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
          id,
        ]);
        if (rows.length) return rows[0].id;
      }
    }

    const numeric = parseInt(String(blancNumber ?? ""), 10);
    if (Number.isFinite(numeric)) {
      const [rows] = await conn.query(
        "SELECT id FROM brokers WHERE PolicyRangeStart <= ? AND PolicyRangeEnd >= ? ORDER BY id LIMIT 1",
        [numeric, numeric]
      );
      if (rows.length) return rows[0].id;
    }

    const [rows] = await conn.query("SELECT id FROM brokers ORDER BY id");
    return rows.length === 1 ? rows[0].id : null;
  });

/**
 * Decrease a broker's balance by `price × Percentage / 100` and decrement
 * InactivePolicies by 1. Runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} price
 * @returns {Promise<number|null>} The charge applied, or null if broker missing.
 */
const decreaseBrokerForInsurance = (module.exports.decreaseBrokerForInsurance =
  async function decreaseBrokerForInsurance(conn, brokerId, price) {
    const [[broker]] = await conn.query(
      "SELECT Percentage FROM brokers WHERE id = ?",
      [brokerId]
    );
    if (!broker) return null;

    const percentage = Number(broker.Percentage) || 0;
    const priceNum = toDecimal(price) || 0;
    // price × Percentage / 100
    const charge = Math.round(priceNum * percentage) / 100;

    await conn.query(
      `UPDATE brokers
            SET CashBalance = CashBalance - ?,
                InactivePolicies = InactivePolicies - 1
          WHERE id = ?`,
      [charge, brokerId]
    );

    return charge;
  });

/**
 * Create the broker router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createBrokerRouter = function createBrokerRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireBrokerRole = requireRole(1, 2);

  const BROKER_COLUMNS =
    "id, Name, CashBalance, Percentage, PolicyRangeStart, PolicyRangeEnd, InactivePolicies";

  function parseBrokerId(param) {
    const id = Number(param);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function parseBrokerEmails(value) {
    if (value === undefined || value === null) return null;
    const list = Array.isArray(value) ? value : [value];
    const emails = list
      .map((e) => String(e ?? "").trim())
      .filter((e) => e.length > 0);
    return emails;
  }

  async function fetchBroker(res, id) {
    const [[broker]] = await DBConnection.query(
      `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
      [id]
    );
    if (!broker) {
      res.status(404).json({ error: "Broker not found" });
      return null;
    }
    const [emails] = await DBConnection.query(
      "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
      [id]
    );
    const [insurances] = await DBConnection.query(
      "SELECT COUNT(*) AS n FROM insurance WHERE BrokerId = ?",
      [id]
    );
    broker.emails = emails.map((r) => r.Email);
    broker.insuranceCount = insurances[0].n;
    return broker;
  }

  // GET /brokers — list every broker with its balance and inactive policies.
  router.get("/brokers", auth, requireBrokerRole, async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
      );
      res.json({ brokers: rows });
    } catch (err) {
      console.error("Broker list failed:", err);
      res.status(500).json({ error: "Failed to fetch brokers" });
    }
  });

  // GET /brokers/export?format=json|csv — extract all broker data.
  router.get("/brokers/export", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
      );
      const [emailRows] = await DBConnection.query(
        "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
      );
      const [insuranceRows] = await DBConnection.query(
        "SELECT BrokerId, COUNT(*) AS n FROM insurance GROUP BY BrokerId"
      );

      const emailsByBroker = new Map();
      for (const e of emailRows) {
        if (!emailsByBroker.has(e.BrokerId)) emailsByBroker.set(e.BrokerId, []);
        emailsByBroker.get(e.BrokerId).push(e.Email);
      }
      const countByBroker = new Map(
        insuranceRows.map((r) => [r.BrokerId, r.n])
      );

      const brokers = rows.map((b) => ({
        ...b,
        emails: emailsByBroker.get(b.id) || [],
        insuranceCount: countByBroker.get(b.id) || 0,
      }));

      const format = String(req.query.format || "json").toLowerCase();
      if (format === "csv") {
        const header = [
          "id",
          "Name",
          "CashBalance",
          "Percentage",
          "PolicyRangeStart",
          "PolicyRangeEnd",
          "InactivePolicies",
          "emails",
          "insuranceCount",
        ];
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [header.join(",")];
        for (const b of brokers) {
          lines.push(
            [
              b.id,
              esc(b.Name),
              b.CashBalance,
              b.Percentage,
              b.PolicyRangeStart,
              b.PolicyRangeEnd,
              b.InactivePolicies,
              esc(b.emails.join(";")),
              b.insuranceCount,
            ].join(",")
          );
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="brokers.csv"'
        );
        return res.send(lines.join("\n"));
      }

      res.json({ brokers });
    } catch (err) {
      console.error("Broker export failed:", err);
      res.status(500).json({ error: "Failed to export brokers" });
    }
  });

  // GET /brokers/:id — single broker.
  router.get("/brokers/:id", auth, requireBrokerRole, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      const [[broker]] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
        [brokerId]
      );
      if (!broker) {
        return res.status(404).json({ error: "Broker not found" });
      }
      res.json({ broker });
    } catch (err) {
      console.error("Broker lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch broker" });
    }
  });

  // POST /brokers/:id/increase  { amount }
  router.post(
    "/brokers/:id/increase",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const amount = parsePositiveAmount(req.body?.amount);
        if (amount === null) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }

        const [result] = await DBConnection.query(
          "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
          [amount, brokerId]
        );
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({ message: "Broker balance increased", amount, broker });
      } catch (err) {
        console.error("Broker increase failed:", err);
        res.status(500).json({ error: "Failed to increase broker balance" });
      }
    }
  );

  // POST /brokers/:id/reduce  { amount } — balance may go negative.
  router.post(
    "/brokers/:id/reduce",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const amount = parsePositiveAmount(req.body?.amount);
        if (amount === null) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }

        const [result] = await DBConnection.query(
          "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
          [amount, brokerId]
        );
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({ message: "Broker balance reduced", amount, broker });
      } catch (err) {
        console.error("Broker reduce failed:", err);
        res.status(500).json({ error: "Failed to reduce broker balance" });
      }
    }
  );

  // ---------------------------------------------------------------------
  // Admin-only broker data manipulation + extraction (role 1)
  // ---------------------------------------------------------------------
  //
  // Manipulation: create, update (fields + emails), and delete brokers.
  // Extraction: export the full broker dataset (including emails and linked
  // insurance counts) as JSON or flattened CSV.

  const requireAdmin = requireRole(1);

  // POST /brokers — create a broker (with optional emails).
  router.post("/brokers", auth, requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.Name ?? req.body?.name ?? "").trim();
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const toNumber = (v) => {
        if (v === undefined || v === null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const cashBalance =
        toNumber(req.body?.CashBalance ?? req.body?.cashBalance) ?? 0;
      const percentage =
        toNumber(req.body?.Percentage ?? req.body?.percentage) ?? 0;
      const rangeStart = toNumber(
        req.body?.PolicyRangeStart ?? req.body?.policyRangeStart
      );
      const rangeEnd = toNumber(
        req.body?.PolicyRangeEnd ?? req.body?.policyRangeEnd
      );
      const inactive =
        toNumber(req.body?.InactivePolicies ?? req.body?.inactivePolicies) ?? 0;

      if (rangeStart === null || rangeEnd === null) {
        return res.status(400).json({
          error: "PolicyRangeStart and PolicyRangeEnd are required",
        });
      }
      if (rangeEnd < rangeStart) {
        return res
          .status(400)
          .json({ error: "PolicyRangeEnd must be >= PolicyRangeStart" });
      }

      const emails = parseBrokerEmails(req.body?.emails) || [];

      await DBConnection.beginTransaction();
      let brokerId;
      try {
        const [result] = await DBConnection.query(
          `INSERT INTO brokers
             (Name, CashBalance, Percentage, PolicyRangeStart, PolicyRangeEnd, InactivePolicies)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [name, cashBalance, percentage, rangeStart, rangeEnd, inactive]
        );
        brokerId = result.insertId;
        for (const email of emails) {
          await DBConnection.query(
            "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
            [brokerId, email]
          );
        }
        await DBConnection.commit();
      } catch (err) {
        try {
          await DBConnection.rollback();
        } catch {
          // ignore
        }
        if (err?.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A broker with this Name already exists" });
        }
        throw err;
      }

      const broker = await fetchBroker(res, brokerId);
      res.status(201).json({ message: "Broker created", broker });
    } catch (err) {
      console.error("Broker create failed:", err);
      res.status(500).json({ error: "Failed to create broker" });
    }
  });

  // PATCH /brokers/:id — update broker fields and/or emails.
  router.patch("/brokers/:id", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }

      const [existing] = await DBConnection.query(
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      const b = req.body || {};
      const sets = [];
      const params = [];

      const fieldMap = [
        ["Name", b.Name ?? b.name],
        ["CashBalance", b.CashBalance ?? b.cashBalance],
        ["Percentage", b.Percentage ?? b.percentage],
        ["PolicyRangeStart", b.PolicyRangeStart ?? b.policyRangeStart],
        ["PolicyRangeEnd", b.PolicyRangeEnd ?? b.policyRangeEnd],
        ["InactivePolicies", b.InactivePolicies ?? b.inactivePolicies],
      ];

      for (const [column, value] of fieldMap) {
        if (value !== undefined && value !== null) {
          const v = column === "Name" ? String(value).trim() : Number(value);
          if (column === "Name" && !v) {
            return res.status(400).json({ error: "Name cannot be empty" });
          }
          if (column !== "Name" && !Number.isFinite(v)) {
            return res
              .status(400)
              .json({ error: `${column} must be a number` });
          }
          sets.push(`${column} = ?`);
          params.push(v);
        }
      }

      const emails = parseBrokerEmails(b.emails);

      if (sets.length === 0 && emails === null) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      await DBConnection.beginTransaction();
      try {
        if (sets.length > 0) {
          params.push(brokerId);
          await DBConnection.query(
            `UPDATE brokers SET ${sets.join(", ")} WHERE id = ?`,
            params
          );
        }
        if (emails !== null) {
          await DBConnection.query(
            "DELETE FROM broker_emails WHERE BrokerId = ?",
            [brokerId]
          );
          for (const email of emails) {
            await DBConnection.query(
              "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
              [brokerId, email]
            );
          }
        }
        await DBConnection.commit();
      } catch (err) {
        try {
          await DBConnection.rollback();
        } catch {
          // ignore
        }
        if (err?.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A broker with this Name already exists" });
        }
        throw err;
      }

      const broker = await fetchBroker(res, brokerId);
      res.json({ message: "Broker updated", broker });
    } catch (err) {
      console.error("Broker update failed:", err);
      res.status(500).json({ error: "Failed to update broker" });
    }
  });

  // DELETE /brokers/:id — remove a broker and detach any linked insurances.
  router.delete("/brokers/:id", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }

      const [existing] = await DBConnection.query(
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      await DBConnection.beginTransaction();
      try {
        // Detach any linked insurance policies before removing the broker.
        await DBConnection.query(
          "UPDATE insurance SET BrokerId = NULL WHERE BrokerId = ?",
          [brokerId]
        );
        await DBConnection.query(
          "DELETE FROM broker_emails WHERE BrokerId = ?",
          [brokerId]
        );
        await DBConnection.query("DELETE FROM brokers WHERE id = ?", [
          brokerId,
        ]);
        await DBConnection.commit();
      } catch (err) {
        try {
          await DBConnection.rollback();
        } catch {
          // ignore
        }
        throw err;
      }

      res.json({ message: "Broker deleted", id: brokerId });
    } catch (err) {
      console.error("Broker delete failed:", err);
      res.status(500).json({ error: "Failed to delete broker" });
    }
  });

  return router;
};

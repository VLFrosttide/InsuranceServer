"use strict";
// Broker balance support.
//
// Each broker has a cash balance that only admins (role 1) and workers
// (role 2) can increase/reduce. Unlike daily current cash, a broker balance
// may go infinitely negative.
//
// Current cash and broker balance are intentionally asymmetric:
//   - Increasing a broker's balance mirrors the same amount into current
//     cash (money is actually coming in), so current cash goes up too.
//   - Reducing a broker's balance (including the per-policy deduction made
//     when an insurance is created from an email card, see
//     decreaseBrokerForInsurance below) never touches current cash. Current
//     cash must never decrease as a side effect of a broker balance
//     reduction, and a broker reduction must never be blocked by how much
//     current cash happens to be available.
//
// Creating an insurance whose email sender is associated with a broker
// deducts a flat fee (the policy price) from that broker's balance and
// decrements the broker's InactivePolicies by 1. No percentages are involved.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { Pricing, seedBrokerTariffsIfMissing } = require("../db/BrokerInfo.js");
const {
  toDecimal,
  recordCashMovement,
  normalizeCurrency,
  normalizeBranch,
} = require("./CurrentCash.js");

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
 * Resolve the broker that an insurance belongs to from the sender of the
 * incoming email.
 *
 * The insurance form no longer asks the worker to pick a broker. Instead the
 * broker is inferred from the "From" address of the unread email the policy is
 * created from: the address must match a row in `broker_emails`, which links
 * back to a `brokers.id`. Accepts both a bare address and a "Name <address>"
 * header value.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} [email]
 * @returns {Promise<{id: number, name: string}|null>} The broker id + name, or
 *   null when the email does not match any broker.
 */
const resolveBrokerByEmail = (module.exports.resolveBrokerByEmail =
  async function resolveBrokerByEmail(conn, email) {
    const raw = String(email ?? "").trim();
    if (!raw) return null;
    let address = raw;
    const m = raw.match(/<([^>]+)>/);
    if (m) address = m[1].trim();
    const [rows] = await conn.query(
      `SELECT be.BrokerId, b.Name
         FROM broker_emails be
         JOIN brokers b ON b.id = be.BrokerId
        WHERE LOWER(be.Email) = LOWER(?)
        ORDER BY be.id
        LIMIT 1`,
      [address]
    );
    if (!rows.length) return null;
    return { id: rows[0].BrokerId, name: rows[0].Name };
  });

/**
 * Deduct the flat fee (the policy price) from a broker's balance and
 * decrement InactivePolicies by 1. The balance is allowed to go negative.
 * Runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} price
 * @returns {Promise<number|null>} The charge applied, or null if broker missing.
 */
const decreaseBrokerForInsurance = (module.exports.decreaseBrokerForInsurance =
  async function decreaseBrokerForInsurance(conn, brokerId, price) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      `UPDATE brokers
            SET CashBalance = CashBalance - ?,
                InactivePolicies = InactivePolicies - 1
          WHERE id = ?`,
      [priceNum, brokerId]
    );

    return priceNum;
  });

/**
 * Restore a broker's balance after an insurance policy linked to it is
 * annulled: increases CashBalance by the full price (the inverse
 * of {@link decreaseBrokerForInsurance}) and increments InactivePolicies by 1
 * since the policy is no longer counted as active. Runs inside the caller's
 * transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} price
 * @returns {Promise<number|null>} The amount restored, or null if broker missing.
 */
const restoreBrokerForAnnulment = (module.exports.restoreBrokerForAnnulment =
  async function restoreBrokerForAnnulment(conn, brokerId, price) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      `UPDATE brokers
            SET CashBalance = CashBalance + ?,
                InactivePolicies = InactivePolicies + 1
          WHERE id = ?`,
      [priceNum, brokerId]
    );

    return priceNum;
  });

/**
 * Re-sync a broker's balance after the price of a policy linked to it is
 * corrected: applies the difference between the new and the old price to
 * CashBalance WITHOUT touching InactivePolicies (the policy is still active,
 * only its price changed). A positive delta charges the broker more, a negative
 * one refunds part of the fee. Runs inside the caller's transaction.
 *
 * This matters because an insurance created from a broker's email is funded
 * entirely by the broker's balance - it never touches current cash - so that
 * balance is the only record of the payment and has to follow price corrections.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} delta  newPrice - oldPrice (may be negative or 0).
 * @returns {Promise<number|null>} The delta applied, or null if broker missing.
 */
const adjustBrokerForPriceChange = (module.exports.adjustBrokerForPriceChange =
  async function adjustBrokerForPriceChange(conn, brokerId, delta) {
    const d = toDecimal(delta) || 0;
    if (d === 0) return 0;

    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
      [d, brokerId]
    );

    return d;
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
    "id, Name, CashBalance, PolicyRangeStart, PolicyRangeEnd, InactivePolicies";

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

  // GET /brokers — list every broker with its balance, inactive policies and emails.
  router.get("/brokers", auth, requireBrokerRole, async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
      );
      const [emailRows] = await DBConnection.query(
        "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
      );
      const emailsByBroker = new Map();
      for (const e of emailRows) {
        if (!emailsByBroker.has(e.BrokerId)) emailsByBroker.set(e.BrokerId, []);
        emailsByBroker.get(e.BrokerId).push(e.Email);
      }
      for (const b of rows) b.emails = emailsByBroker.get(b.id) || [];
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
      const broker = await fetchBroker(res, brokerId);
      if (!broker) return;
      res.json({ broker });
    } catch (err) {
      console.error("Broker lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch broker" });
    }
  });

  // POST /brokers/:id/increase  { amount, reason, currency }
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
        const reason = (
          typeof req.body?.reason === "string" ? req.body.reason : ""
        ).trim();
        if (!reason) {
          return res.status(400).json({ error: "reason is required" });
        }
        const currency = normalizeCurrency(req.body?.currency);
        const branch = normalizeBranch(req.body?.branch);

        // Update the broker balance and mirror the movement into current cash in
        // one transaction, so the two ledgers can never diverge.
        const affectedRows = await DBConnection.withTransaction(
          async (conn) => {
            const [r] = await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [amount, brokerId]
            );
            if (r.affectedRows === 0) return r.affectedRows;

            await recordCashMovement(
              conn,
              branch,
              req.user.username,
              "increase",
              amount,
              reason,
              currency
            );
            return r.affectedRows;
          }
        );

        if (affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({
          message: "Broker balance increased",
          amount,
          currency,
          broker,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Broker increase failed:", err);
        res.status(500).json({ error: "Failed to increase broker balance" });
      }
    }
  );

  // POST /brokers/:id/reduce  { amount, reason, currency } — balance may go
  // infinitely negative. Unlike the increase endpoint, this does NOT touch
  // current cash: current cash only ever increases when a broker balance is
  // increased (money actually coming in), so reducing a broker balance must
  // never decrease current cash or be blocked by its availability.
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
        const reason = (
          typeof req.body?.reason === "string" ? req.body.reason : ""
        ).trim();
        if (!reason) {
          return res.status(400).json({ error: "reason is required" });
        }
        const currency = normalizeCurrency(req.body?.currency);

        const [r] = await DBConnection.query(
          "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
          [amount, brokerId]
        );

        if (r.affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({
          message: "Broker balance reduced",
          amount,
          currency,
          broker,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
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

      let brokerId;
      try {
        brokerId = await DBConnection.withTransaction(async (conn) => {
          const [result] = await conn.query(
            `INSERT INTO brokers
               (Name, CashBalance, PolicyRangeStart, PolicyRangeEnd, InactivePolicies)
             VALUES (?, ?, ?, ?, ?)`,
            [name, cashBalance, rangeStart, rangeEnd, inactive]
          );
          const id = result.insertId;
          for (const email of emails) {
            await conn.query(
              "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
              [id, email]
            );
          }
          return id;
        });
      } catch (err) {
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

      try {
        await DBConnection.withTransaction(async (conn) => {
          if (sets.length > 0) {
            params.push(brokerId);
            await conn.query(
              `UPDATE brokers SET ${sets.join(", ")} WHERE id = ?`,
              params
            );
          }
          if (emails !== null) {
            await conn.query("DELETE FROM broker_emails WHERE BrokerId = ?", [
              brokerId,
            ]);
            for (const email of emails) {
              await conn.query(
                "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
                [brokerId, email]
              );
            }
          }
        });
      } catch (err) {
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

      await DBConnection.withTransaction(async (conn) => {
        // Detach any linked insurance policies before removing the broker.
        await conn.query(
          "UPDATE insurance SET BrokerId = NULL WHERE BrokerId = ?",
          [brokerId]
        );
        await conn.query("DELETE FROM broker_emails WHERE BrokerId = ?", [
          brokerId,
        ]);
        await conn.query("DELETE FROM brokers WHERE id = ?", [brokerId]);
      });

      res.json({ message: "Broker deleted", id: brokerId });
    } catch (err) {
      console.error("Broker delete failed:", err);
      res.status(500).json({ error: "Failed to delete broker" });
    }
  });

  // ---------------------------------------------------------------
  // Broker Pricing endpoints (admin-only)
  // ---------------------------------------------------------------

  // GET /brokers/:brokerId/pricing — retrieve all pricing for a broker
  router.get(
    "/brokers/:brokerId/pricing",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.brokerId);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker ID" });
        }

        // Check if broker exists
        const [brokerCheck] = await DBConnection.query(
          "SELECT id, Name FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (brokerCheck.length === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }
        const brokerName = brokerCheck[0].Name;

        const loadPricing = async () => {
          const [rows] = await DBConnection.query(
            `SELECT InsuranceType, Duration, Price
               FROM broker_tariffs
              WHERE BrokerId = ?
              ORDER BY InsuranceType, Duration`,
            [brokerId]
          );
          // Structure: { vehicleType: { duration: price, ... }, ... }
          const result = {};
          for (const row of rows) {
            if (!result[row.InsuranceType]) result[row.InsuranceType] = {};
            result[row.InsuranceType][String(row.Duration)] = parseFloat(
              row.Price
            );
          }
          return result;
        };

        let pricing = await loadPricing();
        let source = "database";

        // Nothing in the database yet: fall back to BrokerInfo.js and seed it.
        if (Object.keys(pricing).length === 0 && Pricing[brokerName]) {
          try {
            await seedBrokerTariffsIfMissing(
              DBConnection,
              brokerId,
              brokerName
            );
            pricing = await loadPricing();
          } catch (seedErr) {
            console.warn("Broker tariff seed failed:", seedErr.message);
          }
          if (Object.keys(pricing).length === 0) {
            // Seeding failed: still show the BrokerInfo.js values.
            for (const [type, durations] of Object.entries(
              Pricing[brokerName]
            )) {
              pricing[type] = {};
              for (const [d, p] of Object.entries(durations)) {
                pricing[type][String(d)] = Number(p);
              }
            }
          }
          source = "BrokerInfo";
        }

        res.json({
          success: true,
          brokerId,
          brokerName,
          source,
          pricing: pricing,
        });
      } catch (err) {
        console.error("Error fetching broker pricing:", err);
        res.status(500).json({
          success: false,
          error: err.message || "Database error",
        });
      }
    }
  );

  // PUT /brokers/:brokerId/pricing — update pricing for a broker
  router.put(
    "/brokers/:brokerId/pricing",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.brokerId);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker ID" });
        }

        const { pricing } = req.body;

        // Validate request data
        if (!pricing || typeof pricing !== "object") {
          return res.status(400).json({
            success: false,
            error: "Invalid pricing data format",
          });
        }

        // Check if broker exists
        const [brokerCheck] = await DBConnection.query(
          "SELECT id FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (brokerCheck.length === 0) {
          return res.status(404).json({
            success: false,
            error: "Broker not found",
          });
        }

        // Update pricing in transaction
        const updatedPricing = await DBConnection.withTransaction(
          async (conn) => {
            // Delete existing pricing for this broker
            await conn.query("DELETE FROM broker_tariffs WHERE BrokerId = ?", [
              brokerId,
            ]);

            // Insert new pricing
            for (const vehicleType in pricing) {
              // Validate vehicle type
              if (typeof vehicleType !== "string" || !vehicleType.trim()) {
                throw new Error(`Invalid vehicle type: ${vehicleType}`);
              }

              const durations = pricing[vehicleType];

              // Validate durations object
              if (!durations || typeof durations !== "object") {
                throw new Error(
                  `Invalid durations for vehicle type: ${vehicleType}`
                );
              }

              for (const durationStr in durations) {
                const duration = parseInt(durationStr);
                const price = parseFloat(durations[durationStr]);

                // Validate duration
                if (isNaN(duration) || duration <= 0) {
                  throw new Error(`Invalid duration: ${durationStr}`);
                }

                // Validate price
                if (isNaN(price) || price < 0) {
                  throw new Error(
                    `Price cannot be negative for ${vehicleType} ${duration} days`
                  );
                }

                // Insert pricing
                await conn.query(
                  `INSERT INTO broker_tariffs (BrokerId, InsuranceType, Duration, Price)
                    VALUES (?, ?, ?, ?)`,
                  [brokerId, vehicleType, duration, price]
                );
              }
            }

            // Fetch updated pricing to return
            const [updatedRows] = await conn.query(
              `SELECT InsuranceType, Duration, Price
                FROM broker_tariffs
                WHERE BrokerId = ?
                ORDER BY InsuranceType, Duration`,
              [brokerId]
            );

            const updatedPricing = {};
            for (const row of updatedRows) {
              const vehicleType = row.InsuranceType;
              const duration = String(row.Duration);
              const price = parseFloat(row.Price);

              if (!updatedPricing[vehicleType]) {
                updatedPricing[vehicleType] = {};
              }
              updatedPricing[vehicleType][duration] = price;
            }

            return updatedPricing;
          }
        );

        res.json({
          success: true,
          message: "Pricing updated successfully",
          pricing: updatedPricing,
        });
      } catch (err) {
        console.error("Error updating broker pricing:", err);
        res.status(500).json({
          success: false,
          error: err.message || "Error updating pricing",
        });
      }
    }
  );

  return router;
};

"use strict";
// CurrentCash support.
//
// Current cash is a single running balance. It is NOT reset automatically;
// it resets to 0 only when an admin (role 1) or worker (role 2) explicitly
// requests it via POST /currentcash/reset.
//
// Every increase/reduction records the user who performed it and a reason.
// Every reset records the user who performed it and the amount that was kept
// at the time of the reset.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");

// current_cash is a single-row table keyed by this id.
const CASH_ROW_ID = 1;

/**
 * Parse a money value into a number rounded to 2 decimals.
 * Accepts numbers or numeric strings (including "99,5" style decimal commas).
 *
 * @param {number|string} value
 * @returns {number|null}
 */
const toDecimal = (module.exports.toDecimal = function toDecimal(value) {
  if (value === undefined || value === null || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
});

/**
 * Ensure the single current_cash row exists.
 *
 * @param {import("mysql2/promise").Connection} conn
 */
const ensureCashRow = (module.exports.ensureCashRow =
  async function ensureCashRow(conn) {
    await conn.query(
      "INSERT IGNORE INTO current_cash (id, CurrentCash) VALUES (?, 0)",
      [CASH_ROW_ID]
    );
  });

/**
 * Read the current cash balance.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<number>}
 */
const getCurrentCash = (module.exports.getCurrentCash =
  async function getCurrentCash(conn) {
    await ensureCashRow(conn);
    const [rows] = await conn.query(
      "SELECT CurrentCash FROM current_cash WHERE id = ?",
      [CASH_ROW_ID]
    );
    return rows.length ? Number(rows[0].CurrentCash) : 0;
  });

/**
 * Record a single cash movement (increase or reduce).
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username associated with the transaction.
 * @param {"increase"|"reduce"} type
 * @param {number|string} amount  Positive value to add/subtract.
 * @param {string} reason  Human-readable reason for the transaction.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const recordCashMovement = (module.exports.recordCashMovement =
  async function recordCashMovement(conn, username, type, amount, reason) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) {
      throw new Error("amount must be a positive number");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("reason is required");
    }
    if (type !== "increase" && type !== "reduce") {
      throw new Error("type must be 'increase' or 'reduce'");
    }

    await ensureCashRow(conn);

    if (type === "increase") {
      await conn.query(
        "UPDATE current_cash SET CurrentCash = CurrentCash + ? WHERE id = ?",
        [decimal, CASH_ROW_ID]
      );
    } else {
      const [rows] = await conn.query(
        "SELECT CurrentCash FROM current_cash WHERE id = ?",
        [CASH_ROW_ID]
      );
      const balance = rows.length ? Number(rows[0].CurrentCash) : 0;
      if (decimal > balance) {
        throw new Error("insufficient current cash for reduction");
      }
      await conn.query(
        "UPDATE current_cash SET CurrentCash = CurrentCash - ? WHERE id = ?",
        [decimal, CASH_ROW_ID]
      );
    }

    await conn.query(
      `INSERT INTO cash_transactions (Type, Amount, Username, Reason)
       VALUES (?, ?, ?, ?)`,
      [type, decimal, username, reason.trim()]
    );

    return decimal;
  });

/**
 * Reset current cash to zero and record who did it and how much was kept.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username who performed the reset.
 * @returns {Promise<number>} The amount that was kept at reset time.
 */
const resetCurrentCash = (module.exports.resetCurrentCash =
  async function resetCurrentCash(conn, username) {
    await ensureCashRow(conn);

    const [rows] = await conn.query(
      "SELECT CurrentCash FROM current_cash WHERE id = ?",
      [CASH_ROW_ID]
    );
    const kept = rows.length ? Number(rows[0].CurrentCash) : 0;

    await conn.query("UPDATE current_cash SET CurrentCash = 0 WHERE id = ?", [
      CASH_ROW_ID,
    ]);
    await conn.query(
      "INSERT INTO cash_resets (Username, KeptAmount) VALUES (?, ?)",
      [username, kept]
    );

    return kept;
  });

/**
 * Create the CurrentCash router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createCurrentCashRouter = function createCurrentCashRouter(
  DBConnection
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  const requireCashRole = requireRole(1, 2);

  const reasonText = (reason) =>
    typeof reason === "string" ? reason.trim() : "";

  // GET /currentcash — current total, transaction history and reset history.
  router.get("/currentcash", auth, requireCashRole, async (req, res) => {
    try {
      const currentCash = await getCurrentCash(DBConnection);
      const [txs] = await DBConnection.query(
        "SELECT * FROM cash_transactions ORDER BY id DESC"
      );
      const [resets] = await DBConnection.query(
        "SELECT * FROM cash_resets ORDER BY id DESC"
      );
      res.json({ currentCash, transactions: txs, resets });
    } catch (err) {
      console.error("CurrentCash lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch current cash" });
    }
  });

  // POST /currentcash/increase  { amount, reason }
  router.post(
    "/currentcash/increase",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason } = req.body || {};
        await DBConnection.beginTransaction();
        const applied = await recordCashMovement(
          DBConnection,
          req.user.username,
          "increase",
          amount,
          reasonText(reason)
        );
        await DBConnection.commit();

        res.status(201).json({
          message: "Current cash increased",
          amount: applied,
          author: req.user.username,
          reason: reasonText(reason),
        });
      } catch (err) {
        try {
          await DBConnection.rollback();
        } catch {
          // ignore
        }
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash increase failed:", err);
        res.status(500).json({ error: "Failed to increase current cash" });
      }
    }
  );

  // POST /currentcash/reduce  { amount, reason }
  router.post(
    "/currentcash/reduce",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason } = req.body || {};
        await DBConnection.beginTransaction();
        const applied = await recordCashMovement(
          DBConnection,
          req.user.username,
          "reduce",
          amount,
          reasonText(reason)
        );
        await DBConnection.commit();

        res.status(201).json({
          message: "Current cash reduced",
          amount: applied,
          author: req.user.username,
          reason: reasonText(reason),
        });
      } catch (err) {
        try {
          await DBConnection.rollback();
        } catch {
          // ignore
        }
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash reduce failed:", err);
        res.status(500).json({ error: "Failed to reduce current cash" });
      }
    }
  );

  // POST /currentcash/reset — reset current cash to 0 and record the reset.
  router.post("/currentcash/reset", auth, requireCashRole, async (req, res) => {
    try {
      await DBConnection.beginTransaction();
      const kept = await resetCurrentCash(DBConnection, req.user.username);
      await DBConnection.commit();

      res.status(200).json({
        message: "Current cash reset",
        keptAmount: kept,
        author: req.user.username,
      });
    } catch (err) {
      try {
        await DBConnection.rollback();
      } catch {
        // ignore
      }
      console.error("CurrentCash reset failed:", err);
      res.status(500).json({ error: "Failed to reset current cash" });
    }
  });

  return router;
};

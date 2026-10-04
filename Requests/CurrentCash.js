"use strict";
// CurrentCash support (multi-currency).
//
// Current cash is now tracked as one running balance PER CURRENCY (EUR, USD,
// TRY). It is NOT reset automatically; it resets to 0 only when an admin
// (role 1) or worker (role 2) explicitly requests it via
// POST /currentcash/reset, which zeroes every currency at once.
//
// Every increase/reduction records the user who performed it, a reason and the
// currency it applied to. Every reset records the user who performed it and the
// amount that was kept per currency at the time of the reset. Ledger entries
// can be corrected afterwards, but only by their original author.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");

// current_cash is keyed by (id, Currency); id is constant across currencies.
const CASH_ROW_ID = 1;

// Supported cash currencies.
const CURRENCIES = ["EUR", "USD", "TRY"];

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
 * Normalise a currency value to one of the supported codes.
 * Unknown/empty values fall back to EUR so legacy callers keep working.
 *
 * @param {string} value
 * @returns {"EUR"|"USD"|"TRY"}
 */
const normalizeCurrency = (module.exports.normalizeCurrency =
  function normalizeCurrency(value) {
    const s = String(value || "")
      .trim()
      .toUpperCase();
    return CURRENCIES.includes(s) ? s : "EUR";
  });

/**
 * Ensure the single current_cash row exists for a given currency.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} [currency]
 */
const ensureCashRow = (module.exports.ensureCashRow =
  async function ensureCashRow(conn, currency = "EUR") {
    await conn.query(
      "INSERT IGNORE INTO current_cash (id, Currency, CurrentCash) VALUES (?, ?, 0)",
      [CASH_ROW_ID, normalizeCurrency(currency)]
    );
  });

/**
 * Ensure a current_cash row exists for every supported currency.
 *
 * @param {import("mysql2/promise").Connection} conn
 */
const ensureAllCashRows = (module.exports.ensureAllCashRows =
  async function ensureAllCashRows(conn) {
    for (const currency of CURRENCIES) {
      await ensureCashRow(conn, currency);
    }
  });

/**
 * Read the current cash balances, keyed by currency code.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, USD: 0, TRY: 0 }
 */
const getCurrentCash = (module.exports.getCurrentCash =
  async function getCurrentCash(conn) {
    await ensureAllCashRows(conn);
    const [rows] = await conn.query(
      "SELECT Currency, CurrentCash FROM current_cash WHERE id = ?",
      [CASH_ROW_ID]
    );
    const balances = {};
    for (const currency of CURRENCIES) balances[currency] = 0;
    for (const row of rows) {
      if (balances[row.Currency] !== undefined) {
        balances[row.Currency] = Number(row.CurrentCash);
      }
    }
    return balances;
  });

/**
 * Apply a movement (+increase / -reduce) to a currency balance.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} currency
 * @param {"increase"|"reduce"} type
 * @param {number} amount
 */
const adjustBalance = (module.exports.adjustBalance =
  async function adjustBalance(conn, currency, type, amount) {
    await ensureCashRow(conn, currency);

    if (type === "increase") {
      await conn.query(
        "UPDATE current_cash SET CurrentCash = CurrentCash + ? WHERE id = ? AND Currency = ?",
        [amount, CASH_ROW_ID, currency]
      );
      return;
    }

    const [rows] = await conn.query(
      "SELECT CurrentCash FROM current_cash WHERE id = ? AND Currency = ?",
      [CASH_ROW_ID, currency]
    );
    const balance = rows.length ? Number(rows[0].CurrentCash) : 0;
    if (amount > balance) {
      throw new Error("insufficient current cash for reduction");
    }
    await conn.query(
      "UPDATE current_cash SET CurrentCash = CurrentCash - ? WHERE id = ? AND Currency = ?",
      [amount, CASH_ROW_ID, currency]
    );
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
 * @param {string} [currency]  Currency code (EUR/USD/TRY).
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const recordCashMovement = (module.exports.recordCashMovement =
  async function recordCashMovement(
    conn,
    username,
    type,
    amount,
    reason,
    currency
  ) {
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
    const cur = normalizeCurrency(currency);

    await adjustBalance(conn, cur, type, decimal);

    await conn.query(
      `INSERT INTO cash_transactions (Type, Amount, Currency, Username, Reason)
       VALUES (?, ?, ?, ?, ?)`,
      [type, decimal, cur, username, reason.trim()]
    );

    return decimal;
  });

/**
 * Reset current cash to zero (all currencies) and record who did it and how
 * much was kept per currency.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username who performed the reset.
 * @returns {Promise<Record<string, number>>} Kept amount per currency.
 */
const resetCurrentCash = (module.exports.resetCurrentCash =
  async function resetCurrentCash(conn, username) {
    await ensureAllCashRows(conn);

    const [rows] = await conn.query(
      "SELECT Currency, CurrentCash FROM current_cash WHERE id = ?",
      [CASH_ROW_ID]
    );
    const kept = {};
    for (const currency of CURRENCIES) kept[currency] = 0;
    for (const row of rows) {
      if (kept[row.Currency] !== undefined) {
        kept[row.Currency] = Number(row.CurrentCash);
      }
    }

    await conn.query("UPDATE current_cash SET CurrentCash = 0 WHERE id = ?", [
      CASH_ROW_ID,
    ]);
    for (const currency of CURRENCIES) {
      await conn.query(
        "INSERT INTO cash_resets (Username, Currency, KeptAmount) VALUES (?, ?, ?)",
        [username, currency, kept[currency]]
      );
    }

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

  // GET /currentcash — per-currency balances, transaction and reset history.
  router.get("/currentcash", auth, requireCashRole, async (req, res) => {
    try {
      const balances = await getCurrentCash(DBConnection);
      const [txs] = await DBConnection.query(
        "SELECT * FROM cash_transactions ORDER BY id DESC"
      );
      const [resets] = await DBConnection.query(
        "SELECT * FROM cash_resets ORDER BY id DESC"
      );
      res.json({ balances, transactions: txs, resets });
    } catch (err) {
      console.error("CurrentCash lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch current cash" });
    }
  });

  // POST /currentcash/increase  { amount, reason, currency }
  router.post(
    "/currentcash/increase",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency } = req.body || {};
        const cur = normalizeCurrency(currency);
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            req.user.username,
            "increase",
            amount,
            reasonText(reason),
            cur
          )
        );

        res.status(201).json({
          message: "Current cash increased",
          amount: applied,
          currency: cur,
          author: req.user.username,
          reason: reasonText(reason),
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash increase failed:", err);
        res.status(500).json({ error: "Failed to increase current cash" });
      }
    }
  );

  // POST /currentcash/reduce  { amount, reason, currency }
  router.post(
    "/currentcash/reduce",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency } = req.body || {};
        const cur = normalizeCurrency(currency);
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            req.user.username,
            "reduce",
            amount,
            reasonText(reason),
            cur
          )
        );

        res.status(201).json({
          message: "Current cash reduced",
          amount: applied,
          currency: cur,
          author: req.user.username,
          reason: reasonText(reason),
        });
      } catch (err) {
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

  // POST /currentcash/reset — zero all currencies and record the reset.
  router.post("/currentcash/reset", auth, requireCashRole, async (req, res) => {
    try {
      const kept = await DBConnection.withTransaction((conn) =>
        resetCurrentCash(conn, req.user.username)
      );

      res.status(200).json({
        message: "Current cash reset",
        kept,
        author: req.user.username,
      });
    } catch (err) {
      console.error("CurrentCash reset failed:", err);
      res.status(500).json({ error: "Failed to reset current cash" });
    }
  });

  // PATCH /currentcash/transactions/:id — correct a ledger entry.
  // Only the entry's original author may edit it. The running balance is
  // adjusted to match the reversed original movement + the new movement.
  router.patch(
    "/currentcash/transactions/:id",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const [rows] = await DBConnection.query(
          "SELECT * FROM cash_transactions WHERE id = ?",
          [id]
        );
        if (!Number.isInteger(id) || rows.length === 0) {
          return res.status(404).json({ error: "Transaction not found" });
        }

        const tx = rows[0];
        if (String(tx.Username) !== String(req.user.username)) {
          return res.status(403).json({
            error: "Forbidden: you can only edit your own transactions",
          });
        }

        const b = req.body || {};
        const newType = b.Type ?? b.type ?? tx.Type;
        const newCurrency = normalizeCurrency(
          b.Currency ?? b.currency ?? tx.Currency
        );
        const newAmount = toDecimal(b.Amount ?? b.amount ?? tx.Amount);
        const newReason = reasonText(b.Reason ?? b.reason ?? tx.Reason);

        if (newType !== "increase" && newType !== "reduce") {
          return res
            .status(400)
            .json({ error: "type must be 'increase' or 'reduce'" });
        }
        if (newAmount === null || newAmount <= 0) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }
        if (!newReason) {
          return res.status(400).json({ error: "reason is required" });
        }

        const oldType = tx.Type;
        const oldCurrency = normalizeCurrency(tx.Currency);
        const oldAmount = Number(tx.Amount);

        await DBConnection.withTransaction(async (conn) => {
          // Reverse the original movement.
          if (oldType === "increase") {
            await adjustBalance(conn, oldCurrency, "reduce", oldAmount);
          } else {
            await adjustBalance(conn, oldCurrency, "increase", oldAmount);
          }

          // Apply the corrected movement.
          await adjustBalance(conn, newCurrency, newType, newAmount);

          await conn.query(
            `UPDATE cash_transactions
             SET Type = ?, Amount = ?, Currency = ?, Reason = ?
             WHERE id = ?`,
            [newType, newAmount, newCurrency, newReason, id]
          );
        });

        const [updated] = await DBConnection.query(
          "SELECT * FROM cash_transactions WHERE id = ?",
          [id]
        );
        res.json({ message: "Transaction updated", transaction: updated[0] });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (
          msg.includes("amount") ||
          msg.includes("reason") ||
          msg.includes("type")
        ) {
          return res.status(400).json({ error: msg });
        }
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash transaction update failed:", err);
        res.status(500).json({ error: "Failed to update transaction" });
      }
    }
  );

  return router;
};

"use strict";
// Card balance support.
//
// Card balance is a single running balance, separate from current cash.
// When an insurance policy is created with PaymentType = "Card", its price
// is added here instead of to current cash.
//
// Every entry records the user who performed it and a reason (the blanc number).

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { toDecimal, zeroAllCardParts } = require("./CurrentCash.js");

// CardBalance is a single-row table keyed by this id.
const CARD_ROW_ID = 1;

/**
 * Ensure the single CardBalance row exists.
 *
 * @param {import("mysql2/promise").Connection} conn
 */
const ensureCardRow = (module.exports.ensureCardRow =
  async function ensureCardRow(conn) {
    await conn.query(
      "INSERT IGNORE INTO CardBalance (id, CardBalance) VALUES (?, 0)",
      [CARD_ROW_ID]
    );
  });

/**
 * Read the current card balance.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<number>}
 */
const getCardPayments = (module.exports.getCardPayments =
  async function getCardPayments(conn) {
    await ensureCardRow(conn);
    const [rows] = await conn.query(
      "SELECT CardBalance FROM CardBalance WHERE id = ?",
      [CARD_ROW_ID]
    );
    return rows.length ? Number(rows[0].CardBalance) : 0;
  });

/**
 * Record a single card payment (increment).
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username associated with the payment.
 * @param {number|string} amount  Positive value to add.
 * @param {string} reason  Human-readable reason for the payment.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const recordCardPayment = (module.exports.recordCardPayment =
  async function recordCardPayment(conn, username, amount, reason) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) {
      throw new Error("amount must be a positive number");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("reason is required");
    }

    await ensureCardRow(conn);

    await conn.query(
      "UPDATE CardBalance SET CardBalance = CardBalance + ? WHERE id = ?",
      [decimal, CARD_ROW_ID]
    );

    return decimal;
  });

/**
 * Reduce the card balance (e.g. refunding part of an annulled policy that was
 * originally paid by card). Unlike current cash, the card balance is allowed
 * to go negative (it is a running ledger, not a physical cash drawer).
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username associated with the refund.
 * @param {number|string} amount  Positive value to subtract.
 * @param {string} reason  Human-readable reason for the refund.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const reduceCardBalance = (module.exports.reduceCardBalance =
  async function reduceCardBalance(conn, username, amount, reason) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) {
      throw new Error("amount must be a positive number");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("reason is required");
    }

    await ensureCardRow(conn);

    await conn.query(
      "UPDATE CardBalance SET CardBalance = CardBalance - ? WHERE id = ?",
      [decimal, CARD_ROW_ID]
    );

    return decimal;
  });

/**
 * Reset the card balance to zero and record who did it and how much was kept
 * at the time of the reset.
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username  Username who performed the reset.
 * @returns {Promise<number>} The amount that was kept (i.e. the balance just
 *   before it was zeroed).
 */
const resetCardBalance = (module.exports.resetCardBalance =
  async function resetCardBalance(conn, username) {
    await ensureCardRow(conn);

    const [rows] = await conn.query(
      "SELECT CardBalance FROM CardBalance WHERE id = ?",
      [CARD_ROW_ID]
    );
    const kept = rows.length ? Number(rows[0].CardBalance) : 0;

    await conn.query("UPDATE CardBalance SET CardBalance = 0 WHERE id = ?", [
      CARD_ROW_ID,
    ]);

    await conn.query(
      "INSERT INTO card_resets (Username, KeptAmount) VALUES (?, ?)",
      [username, kept]
    );

    // Total cash counts card payments as one of its three payment types, stored
    // per branch/currency in `total_cash.CardPart`. Clearing the card balance
    // must therefore drag Total cash down by the same amount, otherwise the
    // superset identity (TotalCash = CurrentCash + CardPart + BrokerPart) would
    // silently keep the cleared card money in the total.
    await zeroAllCardParts(conn, username);

    return kept;
  });

/**
 * Read the card balance reset history, most recent first.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<Array>}
 */
const getCardResets = (module.exports.getCardResets =
  async function getCardResets(conn) {
    const [rows] = await conn.query(
      "SELECT * FROM card_resets ORDER BY id DESC"
    );
    return rows;
  });

/**
 * Create the CardPayments router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createCardPaymentsRouter = function createCardPaymentsRouter(
  DBConnection
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  const requireCardRole = requireRole(1, 2);
  // Clearing the card balance is a destructive, admin-only action.
  const requireCardAdmin = requireRole(1);

  // GET /cardpayments — current card balance total + reset history.
  router.get("/cardpayments", auth, requireCardRole, async (req, res) => {
    try {
      const cardBalance = await getCardPayments(DBConnection);
      const resets = await getCardResets(DBConnection);
      res.json({ cardBalance, resets });
    } catch (err) {
      console.error("CardPayments lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch card payments" });
    }
  });

  // POST /cardpayments/reset — zero the card balance and record the kept
  // amount. Admin only.
  router.post(
    "/cardpayments/reset",
    auth,
    requireCardAdmin,
    async (req, res) => {
      try {
        const kept = await DBConnection.withTransaction((conn) =>
          resetCardBalance(conn, req.user.username)
        );

        res.status(200).json({
          message: "Card balance reset",
          kept,
          author: req.user.username,
        });
      } catch (err) {
        console.error("CardPayments reset failed:", err);
        res.status(500).json({ error: "Failed to reset card balance" });
      }
    }
  );

  return router;
};

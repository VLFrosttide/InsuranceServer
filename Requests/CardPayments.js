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
const { toDecimal } = require("./CurrentCash.js");

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

  // GET /cardpayments — current card balance total.
  router.get("/cardpayments", auth, requireCardRole, async (req, res) => {
    try {
      const cardBalance = await getCardPayments(DBConnection);
      res.json({ cardBalance });
    } catch (err) {
      console.error("CardPayments lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch card payments" });
    }
  });

  return router;
};

"use strict";
// Card balance support.
//
// Card balance is kept PER BRANCH (`branch_card_balance`, one row per branch),
// separate from current cash. When an insurance policy is created with
// PaymentType = "Card", its price is added to the card balance of the branch
// that issued it instead of to current cash.
//
// A branch's card balance is cleared ONLY together with its current cash, by
// that branch's "Reset to 0" button (POST /currentcash/reset - see
// resetBranch in CurrentCash.js). There is no separate card clear. Every reset
// records the branch, the user who did it and the amount kept.
//
// Workers see their own branch's card balance on the Current cash screen
// (GET /currentcash returns it). The all-branches overview below is admin-only.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { toDecimal, adjustBranchCardBalance } = require("./CurrentCash.js");

/**
 * Read every branch's card balance and the overall total.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<{branches: Array<{Branch: string, CardBalance: number}>, total: number}>}
 */
const getCardPayments = (module.exports.getCardPayments =
  async function getCardPayments(conn) {
    const [rows] = await conn.query(
      "SELECT Branch, CardBalance FROM branch_card_balance ORDER BY Branch"
    );
    const branches = rows.map((r) => ({
      Branch: r.Branch,
      CardBalance: Number(r.CardBalance),
    }));
    const total =
      Math.round(branches.reduce((s, b) => s + b.CardBalance, 0) * 100) / 100;
    return { branches, total };
  });

function validateMovement(amount, reason) {
  const decimal = toDecimal(amount);
  if (decimal === null || decimal <= 0) {
    throw new Error("amount must be a positive number");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }
  return decimal;
}

/**
 * Record a single card payment (increment) on a branch's card balance.
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Branch that took the payment.
 * @param {string} username  Username associated with the payment.
 * @param {number|string} amount  Positive value to add.
 * @param {string} reason  Human-readable reason for the payment.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const recordCardPayment = (module.exports.recordCardPayment =
  async function recordCardPayment(conn, branch, username, amount, reason) {
    const decimal = validateMovement(amount, reason);
    await adjustBranchCardBalance(conn, branch, "increase", decimal);
    return decimal;
  });

/**
 * Reduce a branch's card balance (e.g. refunding part of an annulled policy
 * that was originally paid by card). Unlike current cash, the card balance is
 * allowed to go negative (it is a running ledger, not a physical cash drawer).
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Branch the policy was paid at.
 * @param {string} username  Username associated with the refund.
 * @param {number|string} amount  Positive value to subtract.
 * @param {string} reason  Human-readable reason for the refund.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const reduceCardBalance = (module.exports.reduceCardBalance =
  async function reduceCardBalance(conn, branch, username, amount, reason) {
    const decimal = validateMovement(amount, reason);
    await adjustBranchCardBalance(conn, branch, "reduce", decimal);
    return decimal;
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

  // The all-branches overview shows every branch's card money, so it is
  // admin-only. Workers see their own branch's card balance on the Current
  // cash screen instead.
  const requireCardAdmin = requireRole(1);

  // GET /cardpayments — card balance of every branch, their total
  // (`cardBalance`) and the reset history. Read-only: card balances are only
  // cleared by a branch's "Reset to 0" (POST /currentcash/reset).
  router.get("/cardpayments", auth, requireCardAdmin, async (req, res) => {
    try {
      const { branches, total } = await getCardPayments(DBConnection);
      const resets = await getCardResets(DBConnection);
      res.json({ cardBalance: total, branches, resets });
    } catch (err) {
      console.error("CardPayments lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch card payments" });
    }
  });

  return router;
};

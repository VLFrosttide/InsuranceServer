"use strict";
// CurrentCash support (multi-currency, per-branch).
//
// Current cash is now tracked as one running balance PER BRANCH PER CURRENCY.
// Each branch has its own independent cash balance for EUR, USD, and TRY.
// It is NOT reset automatically; it resets to 0 only when an admin (role 1) or
// worker (role 2) explicitly requests it via POST /currentcash/reset, which
// zeroes every currency at once for the specified branch.
//
// Every increase/reduction records the user who performed it, a reason, the
// currency, and the branch it applied to. Every reset records the user who
// performed it and the amount that was kept per currency at the time of the
// reset. Ledger entries can be corrected afterwards, but only by their original
// author.
//
// ---------------------------------------------------------------------------
// TWO RECORDS OF CASH FLOW: current cash and total cash.
//
//   - CURRENT cash (`current_cash`) is only the cash balance: money that
//     physically arrived as cash. Card payments and policies funded from a
//     broker's balance never touch it.
//   - TOTAL cash is a strict superset of current cash: every type of payment
//     (cash money, card payments and broker-balance payments) is counted in it.
//
// Total cash is not stored as an independent running total. `total_cash` stores
// only the two parts that current cash does not already carry - CardPart and
// BrokerPart - and the total is computed on every read as
//
//     TotalCash(branch, currency) = current_cash.CurrentCash
//                                 + total_cash.CardPart
//                                 + total_cash.BrokerPart
//
// Reading the cash part live from `current_cash` is what makes the superset
// identity structural: resetting current cash - or clearing the card balance,
// which zeroes every CardPart - automatically drags Total cash down with it, so
// the two records can never diverge.
//
// `total_cash_transactions` is the Total cash ledger: one row per movement,
// tagged with the channel it came through (Source = Cash | Card | Broker).
//
// Email cash payments (an insurance created from a broker's email) are funded by
// that broker's balance: the money already entered the drawer when the broker
// topped up, so such a policy REDUCES `brokers.CashBalance` and is recorded
// under the Broker channel only. It must never increase current cash a second
// time.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");

// current_cash is keyed by (id, Branch, Currency); id is constant across
// branches and currencies.
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
 * Normalise a branch value. Empty/null branches become empty string.
 *
 * @param {string} value
 * @returns {string}
 */
const normalizeBranch = (module.exports.normalizeBranch =
  function normalizeBranch(value) {
    return String(value || "").trim();
  });

/**
 * Ensure the current_cash row exists for a given branch and currency.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} [currency]
 */
const ensureCashRow = (module.exports.ensureCashRow =
  async function ensureCashRow(conn, branch, currency = "EUR") {
    const b = normalizeBranch(branch);
    await conn.query(
      "INSERT IGNORE INTO current_cash (id, Branch, Currency, CurrentCash) VALUES (?, ?, ?, 0)",
      [CASH_ROW_ID, b, normalizeCurrency(currency)]
    );
  });

/**
 * Ensure a current_cash row exists for every supported currency for a branch.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 */
const ensureAllCashRows = (module.exports.ensureAllCashRows =
  async function ensureAllCashRows(conn, branch) {
    const b = normalizeBranch(branch);
    for (const currency of CURRENCIES) {
      await ensureCashRow(conn, b, currency);
    }
  });

/**
 * Read the current cash balances for a specific branch, keyed by currency code.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, USD: 0, TRY: 0 }
 */
const getCurrentCash = (module.exports.getCurrentCash =
  async function getCurrentCash(conn, branch) {
    const b = normalizeBranch(branch);
    await ensureAllCashRows(conn, b);
    const [rows] = await conn.query(
      "SELECT Currency, CurrentCash FROM current_cash WHERE id = ? AND Branch = ?",
      [CASH_ROW_ID, b]
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
 * Apply a movement (+increase / -reduce) to a branch/currency balance.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} currency
 * @param {"increase"|"reduce"} type
 * @param {number} amount
 */
const adjustBalance = (module.exports.adjustBalance =
  async function adjustBalance(conn, branch, currency, type, amount) {
    const b = normalizeBranch(branch);
    const cur = normalizeCurrency(currency);
    await ensureCashRow(conn, b, cur);

    if (type === "increase") {
      await conn.query(
        "UPDATE current_cash SET CurrentCash = CurrentCash + ? WHERE id = ? AND Branch = ? AND Currency = ?",
        [amount, CASH_ROW_ID, b, cur]
      );
      return;
    }

    const [rows] = await conn.query(
      "SELECT CurrentCash FROM current_cash WHERE id = ? AND Branch = ? AND Currency = ?",
      [CASH_ROW_ID, b, cur]
    );
    const balance = rows.length ? Number(rows[0].CurrentCash) : 0;
    if (amount > balance) {
      throw new Error("insufficient current cash for reduction");
    }
    await conn.query(
      "UPDATE current_cash SET CurrentCash = CurrentCash - ? WHERE id = ? AND Branch = ? AND Currency = ?",
      [amount, CASH_ROW_ID, b, cur]
    );
  });

// ---------------------------------------------------------------------------
// TOTAL cash - the second record of cash flow (see the file header).
// ---------------------------------------------------------------------------

// total_cash is keyed by (id, Branch, Currency), mirroring current_cash.
const TOTAL_ROW_ID = 1;

// Channels a payment can arrive through. "Cash" movements are carried by
// current_cash itself, so they only produce a ledger row here; "Card" and
// "Broker" movements also update the matching part column in total_cash.
const CASH_SOURCES = ["Cash", "Card", "Broker"];

/**
 * Ensure the total_cash row exists for a given branch and currency.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} [currency]
 */
const ensureTotalRow = (module.exports.ensureTotalRow =
  async function ensureTotalRow(conn, branch, currency = "EUR") {
    const b = normalizeBranch(branch);
    await conn.query(
      "INSERT IGNORE INTO total_cash (id, Branch, Currency, CardPart, BrokerPart) VALUES (?, ?, ?, 0, 0)",
      [TOTAL_ROW_ID, b, normalizeCurrency(currency)]
    );
  });

/**
 * Ensure a total_cash row exists for every supported currency for a branch.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 */
const ensureAllTotalRows = (module.exports.ensureAllTotalRows =
  async function ensureAllTotalRows(conn, branch) {
    const b = normalizeBranch(branch);
    for (const currency of CURRENCIES) {
      await ensureTotalRow(conn, b, currency);
    }
  });

/**
 * Read the stored card/broker parts for a branch, keyed by currency code.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<Record<string, {CardPart: number, BrokerPart: number}>>}
 */
const getTotalParts = (module.exports.getTotalParts =
  async function getTotalParts(conn, branch) {
    const b = normalizeBranch(branch);
    await ensureAllTotalRows(conn, b);
    const [rows] = await conn.query(
      "SELECT Currency, CardPart, BrokerPart FROM total_cash WHERE id = ? AND Branch = ?",
      [TOTAL_ROW_ID, b]
    );
    const parts = {};
    for (const currency of CURRENCIES) {
      parts[currency] = { CardPart: 0, BrokerPart: 0 };
    }
    for (const row of rows) {
      if (parts[row.Currency] !== undefined) {
        parts[row.Currency] = {
          CardPart: Number(row.CardPart),
          BrokerPart: Number(row.BrokerPart),
        };
      }
    }
    return parts;
  });

/**
 * Read the TOTAL cash balances for a branch, keyed by currency code:
 * current cash (read live) + card part + broker part.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, USD: 0, TRY: 0 }
 */
const getTotalCash = (module.exports.getTotalCash =
  async function getTotalCash(conn, branch) {
    const b = normalizeBranch(branch);
    const cash = await getCurrentCash(conn, b);
    const parts = await getTotalParts(conn, b);
    const totals = {};
    for (const currency of CURRENCIES) {
      totals[currency] =
        Math.round(
          (cash[currency] +
            parts[currency].CardPart +
            parts[currency].BrokerPart) *
            100
        ) / 100;
    }
    return totals;
  });

/**
 * Record a single cash movement (increase or reduce) for a branch.
 *
 * NOTE: this runs inside the caller's transaction (the caller is responsible
 * for `beginTransaction` / `commit` / `rollback`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Branch associated with the transaction.
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
    branch,
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
    const b = normalizeBranch(branch);
    const cur = normalizeCurrency(currency);

    await adjustBalance(conn, b, cur, type, decimal);

    await conn.query(
      `INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [b, type, decimal, cur, username, reason.trim()]
    );

    // Cash money is one of the three payment types counted in Total cash. The
    // balance side of Total cash needs no update here - it reads CurrentCash
    // live, so it already moved with adjustBalance above - but the Total cash
    // ledger gets the matching row so both records list the same movement.
    await logTotalCash(
      conn,
      b,
      username,
      type,
      decimal,
      reason,
      cur,
      "Cash"
    );

    return decimal;
  });

/**
 * Apply a movement to one of the stored total_cash parts (CardPart/BrokerPart).
 *
 * Unlike current cash, a part is allowed to go negative: reversing a payment
 * (edit/annulment) must never be blocked by how much happens to be left in that
 * part, and must never fail because the branch was reset in between.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} currency
 * @param {"CardPart"|"BrokerPart"} part
 * @param {"increase"|"reduce"} type
 * @param {number} amount
 */
const adjustTotalPart = (module.exports.adjustTotalPart =
  async function adjustTotalPart(conn, branch, currency, part, type, amount) {
    if (part !== "CardPart" && part !== "BrokerPart") {
      throw new Error("part must be 'CardPart' or 'BrokerPart'");
    }
    if (type !== "increase" && type !== "reduce") {
      throw new Error("type must be 'increase' or 'reduce'");
    }
    const b = normalizeBranch(branch);
    const cur = normalizeCurrency(currency);
    await ensureTotalRow(conn, b, cur);

    const signed = type === "increase" ? amount : -amount;
    await conn.query(
      `UPDATE total_cash SET ${part} = ${part} + ? WHERE id = ? AND Branch = ? AND Currency = ?`,
      [signed, TOTAL_ROW_ID, b, cur]
    );
  });

/**
 * Append one row to the Total cash ledger (`total_cash_transactions`), tagged
 * with the channel the money came through. Every movement that changes Total
 * cash gets a row here so the two records of cash flow can be compared entry by
 * entry. Non-positive amounts are ignored (nothing moved).
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {"increase"|"reduce"} type
 * @param {number|string} amount
 * @param {string} reason
 * @param {string} [currency]
 * @param {"Cash"|"Card"|"Broker"} [source]
 * @returns {Promise<number|null>} The logged amount, or null when nothing moved.
 */
const logTotalCash = (module.exports.logTotalCash =
  async function logTotalCash(
    conn,
    branch,
    username,
    type,
    amount,
    reason,
    currency,
    source
  ) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) return null;
    if (type !== "increase" && type !== "reduce") {
      throw new Error("type must be 'increase' or 'reduce'");
    }
    const src = CASH_SOURCES.includes(source) ? source : "Cash";

    await conn.query(
      `INSERT INTO total_cash_transactions (Branch, Type, Amount, Currency, Source, Username, Reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizeBranch(branch),
        type,
        decimal,
        normalizeCurrency(currency),
        src,
        username,
        String(reason ?? "").trim(),
      ]
    );

    return decimal;
  });

/**
 * Record a payment that arrives through the Card or the Broker channel.
 *
 * Card: the money is held in `CardBalance` (a single global balance), so
 * CardPart keeps the per-branch/per-currency share of it that Total cash adds
 * on top of current cash.
 *
 * Broker: an insurance created from a broker's email is funded by that broker's
 * balance (see decreaseBrokerForInsurance in Brokers.js). The cash already
 * entered the drawer when the broker topped up, so current cash must NOT be
 * increased again - the payment is recorded here only.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {"increase"|"reduce"} type
 * @param {number|string} amount
 * @param {string} reason
 * @param {string} [currency]
 * @param {"Card"|"Broker"} source
 * @returns {Promise<number>} The applied amount.
 */
const recordChannelMovement = (module.exports.recordChannelMovement =
  async function recordChannelMovement(
    conn,
    branch,
    username,
    type,
    amount,
    reason,
    currency,
    source
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
    if (source !== "Card" && source !== "Broker") {
      throw new Error("source must be 'Card' or 'Broker'");
    }

    await adjustTotalPart(
      conn,
      branch,
      currency,
      source === "Card" ? "CardPart" : "BrokerPart",
      type,
      decimal
    );
    await logTotalCash(
      conn,
      branch,
      username,
      type,
      decimal,
      reason,
      currency,
      source
    );

    return decimal;
  });

/**
 * Zero every stored CardPart and record what was kept in the Total cash ledger.
 * Called when the card balance is cleared, so Total cash falls by exactly the
 * same amount as the CardBalance it mirrors.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} username
 * @returns {Promise<number>} The net amount removed across all branches.
 */
const zeroAllCardParts = (module.exports.zeroAllCardParts =
  async function zeroAllCardParts(conn, username) {
    const [rows] = await conn.query(
      "SELECT Branch, Currency, CardPart FROM total_cash WHERE CardPart != 0"
    );

    let removed = 0;
    for (const row of rows) {
      const kept = Number(row.CardPart);
      removed = Math.round((removed + kept) * 100) / 100;
      // A part can legitimately be negative after reversals; log the movement
      // in the direction that actually brings it back to 0.
      await logTotalCash(
        conn,
        row.Branch,
        username,
        kept >= 0 ? "reduce" : "increase",
        Math.abs(kept),
        "Card balance cleared",
        row.Currency,
        "Card"
      );
    }

    await conn.query("UPDATE total_cash SET CardPart = 0");
    return removed;
  });

/**
 * Reset current cash to zero (all currencies) for a branch and record who did
 * it and how much was kept per currency.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Branch to reset.
 * @param {string} username  Username who performed the reset.
 * @returns {Promise<Record<string, number>>} Kept amount per currency.
 */
const resetCurrentCash = (module.exports.resetCurrentCash =
  async function resetCurrentCash(conn, branch, username) {
    const b = normalizeBranch(branch);
    await ensureAllCashRows(conn, b);

    const [rows] = await conn.query(
      "SELECT Currency, CurrentCash FROM current_cash WHERE id = ? AND Branch = ?",
      [CASH_ROW_ID, b]
    );
    const kept = {};
    for (const currency of CURRENCIES) kept[currency] = 0;
    for (const row of rows) {
      if (kept[row.Currency] !== undefined) {
        kept[row.Currency] = Number(row.CurrentCash);
      }
    }

    await conn.query(
      "UPDATE current_cash SET CurrentCash = 0 WHERE id = ? AND Branch = ?",
      [CASH_ROW_ID, b]
    );
    for (const currency of CURRENCIES) {
      await conn.query(
        "INSERT INTO cash_resets (Branch, Username, Currency, KeptAmount) VALUES (?, ?, ?, ?)",
        [b, username, currency, kept[currency]]
      );
      // Total cash is a strict superset of current cash, so zeroing the drawer
      // drags it down by the same kept amount. The balance follows automatically
      // (Total cash reads CurrentCash live); this row records it in the ledger.
      await logTotalCash(
        conn,
        b,
        username,
        "reduce",
        kept[currency],
        "Current cash reset",
        currency,
        "Cash"
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

  // GET /currentcash/branches — all branches with cash (branches that have any
  // non-zero balance in any currency).
  router.get(
    "/currentcash/branches",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const [rows] = await DBConnection.query(
          `SELECT DISTINCT Branch FROM current_cash WHERE CurrentCash != 0 ORDER BY Branch`
        );
        const branches = rows.map((r) => r.Branch);

        // Fetch balances for each branch
        const branchData = {};
        for (const branch of branches) {
          const balances = await getCurrentCash(DBConnection, branch);
          const nonZero = Object.entries(balances).filter(
            ([, value]) => Number(value) !== 0
          );
          if (nonZero.length > 0) {
            branchData[branch] = Object.fromEntries(nonZero);
          }
        }

        res.json({ branches: branchData });
      } catch (err) {
        console.error("CurrentCash branches lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch branches" });
      }
    }
  );

  // GET /currentcash — per-currency balances, transaction and reset history
  // for the branch specified in the query string (?branch=...).
  router.get("/currentcash", auth, requireCashRole, async (req, res) => {
    try {
      const branch = normalizeBranch(req.query.branch);
      const balances = await getCurrentCash(DBConnection, branch);
      const [txs] = await DBConnection.query(
        "SELECT * FROM cash_transactions WHERE Branch = ? ORDER BY id DESC",
        [branch]
      );
      const [resets] = await DBConnection.query(
        "SELECT * FROM cash_resets WHERE Branch = ? ORDER BY id DESC",
        [branch]
      );
      res.json({ balances, transactions: txs, resets });
    } catch (err) {
      console.error("CurrentCash lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch current cash" });
    }
  });

  // POST /currentcash/increase  { amount, reason, currency, branch }
  router.post(
    "/currentcash/increase",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency, branch } = req.body || {};
        const cur = normalizeCurrency(currency);
        const b = normalizeBranch(branch);
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            b,
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
          branch: b,
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

  // POST /currentcash/reduce  { amount, reason, currency, branch }
  router.post(
    "/currentcash/reduce",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency, branch } = req.body || {};
        const cur = normalizeCurrency(currency);
        const b = normalizeBranch(branch);
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            b,
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
          branch: b,
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

  // POST /currentcash/reset — zero all currencies for a branch and record the
  // reset. Expects { branch } in the body.
  router.post("/currentcash/reset", auth, requireCashRole, async (req, res) => {
    try {
      const { branch } = req.body || {};
      const b = normalizeBranch(branch);
      const kept = await DBConnection.withTransaction((conn) =>
        resetCurrentCash(conn, b, req.user.username)
      );

      res.status(200).json({
        message: "Current cash reset",
        kept,
        branch: b,
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
  // The branch is taken from the original transaction (cannot be changed).
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
        // Branch is preserved from the original transaction.
        const txBranch = normalizeBranch(tx.Branch);

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
            await adjustBalance(
              conn,
              txBranch,
              oldCurrency,
              "reduce",
              oldAmount
            );
          } else {
            await adjustBalance(
              conn,
              txBranch,
              oldCurrency,
              "increase",
              oldAmount
            );
          }

          // Apply the corrected movement.
          await adjustBalance(conn, txBranch, newCurrency, newType, newAmount);

          // Mirror the correction into the Total cash ledger. Total cash reads
          // CurrentCash live so its balance is already correct; these rows keep
          // the two records of cash flow listing the same movements.
          await logTotalCash(
            conn,
            txBranch,
            req.user.username,
            oldType === "increase" ? "reduce" : "increase",
            oldAmount,
            `Correction of cash transaction #${id}`,
            oldCurrency,
            "Cash"
          );
          await logTotalCash(
            conn,
            txBranch,
            req.user.username,
            newType,
            newAmount,
            `Correction of cash transaction #${id}`,
            newCurrency,
            "Cash"
          );

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

  // ---------------------------------------------------------------------
  // TOTAL cash - the second record of cash flow.
  // ---------------------------------------------------------------------

  // GET /totalcash/branches — branches with any non-zero TOTAL cash (i.e. any
  // non-zero current cash, card part or broker part).
  router.get("/totalcash/branches", auth, requireCashRole, async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT DISTINCT Branch FROM (
           SELECT Branch FROM current_cash WHERE CurrentCash != 0
           UNION
           SELECT Branch FROM total_cash WHERE CardPart != 0 OR BrokerPart != 0
         ) AS branches ORDER BY Branch`
      );

      const branchData = {};
      for (const row of rows) {
        const totals = await getTotalCash(DBConnection, row.Branch);
        const nonZero = Object.entries(totals).filter(
          ([, value]) => Number(value) !== 0
        );
        if (nonZero.length > 0) {
          branchData[row.Branch] = Object.fromEntries(nonZero);
        }
      }

      res.json({ branches: branchData });
    } catch (err) {
      console.error("TotalCash branches lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch branches" });
    }
  });

  // GET /totalcash?branch=... — the per-currency TOTAL cash (current cash +
  // card part + broker part), the parts it is built from, and the ledger with
  // the channel (Source) each movement came through.
  router.get("/totalcash", auth, requireCashRole, async (req, res) => {
    try {
      const branch = normalizeBranch(req.query.branch);
      const balances = await getTotalCash(DBConnection, branch);
      const parts = await getTotalParts(DBConnection, branch);
      const [txs] = await DBConnection.query(
        "SELECT * FROM total_cash_transactions WHERE Branch = ? ORDER BY id DESC",
        [branch]
      );
      res.json({ balances, parts, transactions: txs });
    } catch (err) {
      console.error("TotalCash lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch total cash" });
    }
  });

  return router;
};

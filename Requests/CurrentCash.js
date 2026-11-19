"use strict";
// CurrentCash support (multi-currency, per-branch).
//
// Current cash is now tracked as one running balance PER BRANCH PER CURRENCY.
// Each branch has its own independent cash balance for EUR and TRY.
// It is NOT reset automatically; it resets to 0 only when an admin (role 1) or
// worker (role 2) explicitly requests it via POST /currentcash/reset, which
// zeroes every currency at once for the specified branch.
//
// Every increase/reduction records the user who performed it, a reason, the
// currency, and the branch it applied to. Every reset records the user who
// performed it and the amount that was kept per currency at the time of the
// reset. Ledger entries can be corrected afterwards, but only by their original
// author. An admin can also DELETE a ledger entry: it is soft-deleted (kept in
// the table, flagged with Deleted/DeletedAt/DeletedBy) and its money is moved in
// the opposite direction, so the drawer and the Total cash ledger both stop
// counting it.
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
// identity structural: resetting a branch - which zeroes its current cash and
// its card balance (and so its CardPart) - automatically drags that branch's
// Total cash down with it, so the two records can never diverge.
//
// `total_cash_transactions` is the Total cash ledger: one row per movement,
// tagged with the channel it came through (Source = Cash | Card | Broker).
//
// One movement is deliberately NOT in that ledger: a HAND-OVER (see below). It
// leaves the drawer without arriving through any channel, so the Total cash
// BALANCE falls (its cash share is current_cash, read live) while the Total cash
// ledger stays as it was. Every other writer keeps the two in step, so a
// reconciliation of that ledger against the balance has to subtract the
// `Type = 'handover'` rows of `cash_transactions` it is missing.
//
// Email cash payments (an insurance created from a broker's email) are funded by
// that broker's balance: the money was already handed over when the broker
// topped up, so such a policy REDUCES `brokers.CashBalance` and is recorded
// under the Broker channel only. It must never increase current cash.
//
// CASH FROM BROKERS is a third, separate balance: the money a broker hands over
// when their balance is topped up. It is NOT part of current cash (see "Cash
// from brokers, per branch" below).
//
// CASH HANDED OVER is a reduction of the drawer that is NOT an expense: money
// physically given to a person - a runner taking the takings to the safe, the
// owner collecting the day's cash ... Its ledger row carries
// Type = 'handover' and, in `Recipient`, who took the money (the reason says
// why). It lowers current cash (and therefore Available cash) and, because the
// cash part of Total cash is read live, the Total cash balance too, but it is
// NOT a sale of the day: no `total_cash_transactions` row is written, it is
// excluded from Total daily cash and it never counts as an expense. See
// "Expences / hand-overs" below.
//
// A HAND-OVER CAN BE UNDONE (admin only). The money comes back, and the admin
// says where it went:
//   - to the office drawer: `current_cash` grows again through a ledger row of
//     Type = 'handover_return' (positive), so the drawer and its historical walk
//     stay in step - but it is still NOT a sale, so it has no Total cash row and
//     does not move Total daily cash;
//   - straight to the company bank account: no drawer is touched at all. Only a
//     row in `cash_handover_returns` is written, which lowers how much is still
//     handed over.
// Every return is recorded in `cash_handover_returns`, linked to the original
// hand-over and (for a drawer return) to the ledger row that put the money back.
// A hand-over may be returned in parts, so the statistics compare the hand-over
// with the sum of its returns. A hand-over that was deleted instead of returned
// is counted as "undone": its money went back to the drawer in full.
//
// Broker-balance hand-overs (Type = 'handover' in `broker_balance_movements`,
// see Requests/Brokers.js) are tracked in the same statistics. They carry no
// branch and are undone from the broker's history (which reverses the broker's
// balance), so the drawer return route above only applies to cash hand-overs.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");

// current_cash is keyed by (id, Branch, Currency); id is constant across
// branches and currencies.
const CASH_ROW_ID = 1;

// Supported cash currencies.
const CURRENCIES = ["EUR", "TRY"];

// The ledger `Type` of money handed over to a person: it leaves the drawer, but
// it is neither a sale (so it stays out of Total daily cash) nor money the
// branch spent (so it stays out of the expenses).
const HANDOVER_TYPE = "handover";

// The ledger `Type` of money that was handed over and has now come back into
// the drawer. It is a positive movement (like an increase) for the balance and
// the historical walk, but - exactly like the hand-over it reverses - it is not
// a sale, so it writes no Total cash row and stays out of Total daily cash.
const HANDOVER_RETURN_TYPE = "handover_return";

// Where returned hand-over money can go. "drawer" increases available cash;
// "bank" leaves every drawer untouched and only lowers the handed-over total.
const HANDOVER_RETURN_DESTINATIONS = ["drawer", "bank"];

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
 * @returns {"EUR"|"TRY"}
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
 * Round a money value to the two decimals the ledger stores.
 *
 * @param {unknown} value
 * @returns {number}
 */
const roundMoney = (module.exports.roundMoney = function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
});

// ---------------------------------------------------------------------------
// Transaction history by day.
//
// The current cash screen lists the ledger (transactions and resets) one day
// at a time. Any day can be requested; without one, today is used. "Today" is
// the CLIENT's calendar day: the client sends its UTC offset in minutes (east
// of UTC positive, the same convention as TzOffset when an insurance is
// created). A missing/invalid offset falls back to UTC. CreatedAt is compared
// as the stored wall-clock value, i.e. the same value the screen displays.
// ---------------------------------------------------------------------------

// Real-world UTC offsets range from UTC-12:00 to UTC+14:00.
const MIN_TZ_OFFSET_MINUTES = -12 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/**
 * Shift a "YYYY-MM-DD" date by a number of calendar days.
 *
 * @param {string} ymd
 * @param {number} days
 * @returns {string}
 */
const addDays = (module.exports.addDays = function addDays(ymd, days) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
});

/**
 * The client's current calendar day as "YYYY-MM-DD".
 *
 * @param {unknown} offsetMinutes  Client UTC offset in minutes.
 * @param {Date} [now]  Current instant (injectable for tests).
 * @returns {string}
 */
const clientLocalDate = (module.exports.clientLocalDate =
  function clientLocalDate(offsetMinutes, now = new Date()) {
    let offset = Number(offsetMinutes);
    if (
      !Number.isFinite(offset) ||
      offset < MIN_TZ_OFFSET_MINUTES ||
      offset > MAX_TZ_OFFSET_MINUTES
    ) {
      offset = 0;
    }
    return new Date(now.getTime() + Math.round(offset) * 60000)
      .toISOString()
      .slice(0, 10);
  });

/**
 * Resolve which day of the ledger to return. An empty date means the client's
 * today. Returns `{ date, nextDate }`, or `{ error }` when the date is
 * malformed.
 *
 * @param {unknown} dateValue  Requested day ("YYYY-MM-DD").
 * @param {unknown} offsetMinutes  Client UTC offset in minutes.
 * @param {Date} [now]  Current instant (injectable for tests).
 */
const resolveHistoryDay = (module.exports.resolveHistoryDay =
  function resolveHistoryDay(dateValue, offsetMinutes, now = new Date()) {
    const raw =
      dateValue === undefined || dateValue === null
        ? ""
        : String(dateValue).trim();
    if (raw === "") {
      const today = clientLocalDate(offsetMinutes, now);
      return { date: today, nextDate: addDays(today, 1) };
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    // Round-tripping through addDays rejects impossible dates (2026-02-31).
    if (!m || addDays(raw, 0) !== raw) {
      return { error: "date must be in YYYY-MM-DD format" };
    }
    return { date: raw, nextDate: addDays(raw, 1) };
  });

/**
 * Validate a wall-clock time computed by the client (a MySQL DATETIME string
 * "YYYY-MM-DD HH:MM:SS"; a "T" separator is accepted too). Impossible
 * dates/times (2026-02-31, 25:00) are rejected.
 *
 * @param {unknown} value
 * @returns {string|null} The normalised "YYYY-MM-DD HH:MM:SS", or null.
 */
const parseClientDateTime = (module.exports.parseClientDateTime =
  function parseClientDateTime(value) {
    if (typeof value !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
      value.trim()
    );
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (
      t.getUTCFullYear() !== y ||
      t.getUTCMonth() !== mo - 1 ||
      t.getUTCDate() !== d ||
      t.getUTCHours() !== h ||
      t.getUTCMinutes() !== mi ||
      t.getUTCSeconds() !== s
    ) {
      return null;
    }
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  });

/**
 * The server clock shifted by the client's UTC offset in minutes (east
 * positive), as a MySQL DATETIME string. This is the fallback when the client
 * does not send its own wall-clock time. A missing/invalid offset yields the
 * server's UTC clock — the same value the old DEFAULT CURRENT_TIMESTAMP (the
 * database's NOW()) used to stamp, so non-cash flows keep their old behaviour.
 * Never calls the database's NOW().
 *
 * @param {unknown} offsetMinutes
 * @param {Date} [now]
 * @returns {string}
 */
const clientLocalDateTime = (module.exports.clientLocalDateTime =
  function clientLocalDateTime(offsetMinutes, now = new Date()) {
    let offset = Number(offsetMinutes);
    if (
      !Number.isFinite(offset) ||
      offset < MIN_TZ_OFFSET_MINUTES ||
      offset > MAX_TZ_OFFSET_MINUTES
    ) {
      offset = 0;
    }
    const local = new Date(now.getTime() + Math.round(offset) * 60000);
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(
        local.getUTCDate()
      )} ` +
      `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(
        local.getUTCSeconds()
      )}`
    );
  });

/**
 * Resolve the CreatedAt for a new ledger row from a request body: the client's
 * own wall-clock time is stored as sent, otherwise the server clock shifted by
 * the client's TzOffset. Returns `{ createdAt }` or `{ error }`.
 *
 * @param {object} [body]
 * @param {Date} [now]
 * @returns {{createdAt: string}|{error: string}}
 */
const resolveRequestCreatedAt = (module.exports.resolveRequestCreatedAt =
  function resolveRequestCreatedAt(body, now = new Date()) {
    const b = body || {};
    const sent = b.CreatedAt ?? b.createdAt;
    if (sent !== undefined && sent !== null && sent !== "") {
      const parsed = parseClientDateTime(sent);
      if (!parsed) {
        return { error: "CreatedAt must be in YYYY-MM-DD HH:MM:SS format" };
      }
      return { createdAt: parsed };
    }
    return {
      createdAt: clientLocalDateTime(b.TzOffset ?? b.tzOffset ?? null, now),
    };
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
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, TRY: 0 }
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

// The amount of money a walk-in policy puts into the cash drawer: its price
// while it stands, or just the annulment fee once it is annulled - the same
// rule every other money figure of the day uses. A soft-deleted policy
// contributes nothing (the callers filter it out).
const INSURANCE_AMOUNT_SQL =
  "ROUND(SUM(CASE WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2)) " +
  "ELSE COALESCE(AnnulFee, 0) END), 2)";

// Lower bound of "everything that ever happened", used when a currency has
// never been reset.
const DAWN_OF_TIME = "1970-01-01 00:00:00";

/**
 * Read the cash a branch's drawer held at the end of a given day, DERIVED FROM
 * THE POLICIES AND THE MANUAL MOVEMENTS instead of a running balance.
 *
 *     availableCash(end of D) = the drawer of the branch's open shift
 *                             (= 0 from its last reset before D)
 *                             + cash of the walk-in policies created after that
 *                               reset and before D
 *                             + manual drawer movements of that window
 *                               (increase +, expense -, hand-over -,
 *                                returned hand-over +)
 *
 * Why it is computed and not stored:
 *
 *   - A policy's money is read LIVE from `insurance`, so correcting a policy
 *     (price, payment type, currency, branch, annulment, deletion) changes the
 *     figure by exactly the policy's new contribution: nothing has to be
 *     reversed, and an edited policy stays on ITS creation date instead of
 *     leaving a correction behind on the day it was edited.
 *   - Corrections therefore never pile up wrongly, which is what made the old
 *     running balance drift away from the physical drawer.
 *
 * The ledger rows the insurance flows write (the sale itself, "Edit <blanc>",
 * "Annul <blanc>", "Delete <blanc>", "Restore <blanc>", "Price change <blanc>")
 * are deliberately NOT counted: the policy they belong to is already counted
 * above, so adding them would count the same money twice. Only the rows typed
 * in by hand - and hand-overs - are added.
 *
 * A reset ("End shift") empties the drawer and records what was handed over in
 * `KeptAmount`, so the latest reset before the requested day starts the window
 * and the balance from there is 0 - exactly the drawer a new shift opens with.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} nextDate  "YYYY-MM-DD" of the day AFTER the requested day
 *                           (exclusive upper bound).
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, TRY: 0 }
 */
const getAvailableCashAsOf = (module.exports.getAvailableCashAsOf =
  async function getAvailableCashAsOf(conn, branch, nextDate) {
    const b = normalizeBranch(branch);
    const balances = {};
    const windowStart = {};
    for (const currency of CURRENCIES) {
      balances[currency] = 0;
      windowStart[currency] = DAWN_OF_TIME;
    }

    // The last reset per currency before the end of the requested day. A reset
    // hands the money over and leaves the drawer at 0, so it is both the
    // starting balance and the start of the window the movements come from.
    const [resets] = await conn.query(
      `SELECT Currency, CreatedAt
         FROM cash_resets
        WHERE Branch = ? AND CreatedAt < ?
        ORDER BY CreatedAt ASC, id ASC`,
      [b, nextDate]
    );
    for (const row of resets || []) {
      const cur = normalizeCurrency(row.Currency);
      if (balances[cur] === undefined) continue;
      balances[cur] = 0;
      windowStart[cur] = row.CreatedAt || DAWN_OF_TIME;
    }

    // Money the walk-in cash policies of the window brought in. Their price is
    // read live, so an edited policy is counted at its corrected price on its
    // own creation date, and an annulled one only at the annulment fee.
    const insuranceClauses = [];
    const insuranceParams = [];
    for (const currency of CURRENCIES) {
      insuranceClauses.push("(CurrencyType = ? AND CreationDate >= ?)");
      insuranceParams.push(currency, windowStart[currency]);
    }
    const [insuranceRows] = await conn.query(
      `SELECT CurrencyType AS Currency, ${INSURANCE_AMOUNT_SQL} AS Total
         FROM insurance
        WHERE Deleted = 0 AND Branch = ?
          AND BrokerId IS NULL AND PaymentType = 'Cash'
          AND (${insuranceClauses.join(" OR ")})
          AND CreationDate < ?
        GROUP BY CurrencyType`,
      [b, ...insuranceParams, nextDate]
    );
    for (const row of insuranceRows || []) {
      const cur = normalizeCurrency(row.Currency);
      if (balances[cur] === undefined) continue;
      balances[cur] = roundMoney(balances[cur] + (Number(row.Total) || 0));
    }

    // The drawer movements typed in by hand, plus hand-overs and their
    // returns. Rows belonging to a policy are recognised by their reason (the
    // "Annul "/"Edit "/... prefixes, or the policy's own blanc number) and are
    // skipped - the policy itself is counted above.
    const movementClauses = [];
    const movementParams = [];
    for (const currency of CURRENCIES) {
      movementClauses.push("(ct.Currency = ? AND ct.CreatedAt >= ?)");
      movementParams.push(currency, windowStart[currency]);
    }
    const [movements] = await conn.query(
      `SELECT ct.Type, ct.Amount, ct.Currency, ct.Reason,
              p.BlancNumber AS PolicyBlanc
         FROM cash_transactions ct
         LEFT JOIN insurance p ON p.BlancNumber = ct.Reason
        WHERE ct.Branch = ? AND ct.Deleted = 0
          AND (${movementClauses.join(" OR ")})
          AND ct.CreatedAt < ?`,
      [b, ...movementParams, nextDate]
    );
    for (const row of movements || []) {
      const cur = normalizeCurrency(row.Currency);
      if (balances[cur] === undefined) continue;
      // A sale or a correction of a policy: already counted from `insurance`.
      if (row.PolicyBlanc !== null && row.PolicyBlanc !== undefined) continue;
      if (isPolicyMovementReason(row.Reason)) continue;
      const amount = Number(row.Amount) || 0;
      const type = String(row.Type || "").trim().toLowerCase();
      if (type === "increase" || type === HANDOVER_RETURN_TYPE) {
        balances[cur] = roundMoney(balances[cur] + amount);
      } else if (type === "reduce" || type === HANDOVER_TYPE) {
        balances[cur] = roundMoney(balances[cur] - amount);
      }
    }

    return balances;
  });

// Kept under its historical name for the callers/tests that still use it.
const getCurrentCashAsOf = (module.exports.getCurrentCashAsOf =
  getAvailableCashAsOf);

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
 * Because the cash share is read live from `current_cash`, every drawer
 * movement changes this total - including a HAND-OVER, which by design has no
 * row in `total_cash_transactions` (see the file header). So this balance can be
 * lower than "sum of the Total cash ledger" by the branch's hand-overs; anyone
 * comparing the two must take those into account.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, TRY: 0 }
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
 * @param {string} [currency]  Currency code (EUR/TRY).
 * @param {string} [createdAt]  Client's local wall-clock time
 *   ("YYYY-MM-DD HH:MM:SS"). Defaults to the server's UTC clock.
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
    currency,
    createdAt
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
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    await adjustBalance(conn, b, cur, type, decimal);

    await conn.query(
      `INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [b, type, decimal, cur, username, reason.trim(), ts]
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
      "Cash",
      ts
    );

    return decimal;
  });

/**
 * Record money physically HANDED OVER to a person (a runner taking the day's
 * takings to the safe, the owner collecting cash ...).
 *
 * The drawer is reduced exactly like an expense, but the entry is a different
 * kind of reduction:
 *   - it is written with Type = 'handover' and the person who took the money in
 *     `Recipient`, so the ledger says who received it;
 *   - NO row is written to the Total cash ledger, so the day's Total daily cash
 *     keeps showing only the money that came in and was spent;
 *   - the expenses of the day (see splitExpences below) only take Type =
 *     'reduce', so a hand-over is never counted as money the branch spent.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {number|string} amount  Positive value to take out of the drawer.
 * @param {string} reason  Why the money was handed over.
 * @param {string} recipient  Who received the money.
 * @param {string} [currency]
 * @param {string} [createdAt]  Client's local wall-clock time
 *   ("YYYY-MM-DD HH:MM:SS"). Defaults to the server's UTC clock.
 * @returns {Promise<number>} The applied amount (rounded to 2 decimals).
 */
const recordCashHandover = (module.exports.recordCashHandover =
  async function recordCashHandover(
    conn,
    branch,
    username,
    amount,
    reason,
    recipient,
    currency,
    createdAt
  ) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) {
      throw new Error("amount must be a positive number");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("reason is required");
    }
    if (typeof recipient !== "string" || !recipient.trim()) {
      throw new Error("recipient is required");
    }
    const b = normalizeBranch(branch);
    const cur = normalizeCurrency(currency);
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    await adjustBalance(conn, b, cur, "reduce", decimal);

    await conn.query(
      `INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, Recipient, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b,
        HANDOVER_TYPE,
        decimal,
        cur,
        username,
        reason.trim(),
        recipient.trim(),
        ts,
      ]
    );

    // Deliberately no logTotalCash() here: the money did not arrive through any
    // payment channel, so it must not appear in the Total cash ledger and must
    // not move Total daily cash.

    return decimal;
  });

/**
 * Record a cash movement in the `cash_transactions` ledger WITHOUT touching the
 * running `current_cash` balance. Used when a correction is back-dated to an
 * earlier day whose drawer has already been closed (each day has its own
 * drawer): the movement must reduce that earlier day's daily total, not today's
 * running drawer.
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
 * @param {string} [createdAt]
 * @returns {Promise<number>}
 */
const recordCashLedgerOnly = (module.exports.recordCashLedgerOnly =
  async function recordCashLedgerOnly(
    conn,
    branch,
    username,
    type,
    amount,
    reason,
    currency,
    createdAt
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
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    await conn.query(
      `INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [b, type, decimal, cur, username, reason.trim(), ts]
    );

    return decimal;
  });

// ---------------------------------------------------------------------------
// Expences: the money that left a branch's drawer BY HAND on one day.
//
// The drawer's ledger (`cash_transactions`) holds three kinds of reductions:
//
//   - the MANUAL ones, entered with the "Expense" button together with a reason
//     the worker typed in ("rent", "supplies", "salary" ...). Those are the
//     branch's expenses.
//   - the ones the insurances routes write when a policy moves money: the
//     refund of an annulled policy, the money a deletion gives back, and the
//     reversal of an edit/price correction. They lower the drawer too, but they
//     are policy movements, NOT money the branch spent, so they must not be
//     counted as expenses.
//   - the HAND-OVERS (Type = 'handover'), entered with the "Hand over" button:
//     cash given to a named person that leaves the drawer but is not spent by
//     the branch. They are a separate type, so they are never expenses.
//
// A ledger row carries no reference to the policy it belongs to, so the second
// kind is recognised by the reason its writer always uses (see
// Requests/TierEndpoints.js): "Annul <blanc>", "Delete <blanc>",
// "Restore <blanc>", "Edit <blanc>" and "Price change <blanc>". Every other
// reduction of Type 'reduce' was typed in by hand and is an expense.
// ---------------------------------------------------------------------------

const POLICY_MOVEMENT_REASON_PREFIXES = [
  "Annul ",
  "Delete ",
  "Restore ",
  "Edit ",
  "Price change ",
];

/**
 * Whether a cash-ledger reason was written by an insurance movement
 * (annulment, deletion, restoration, edit or price correction) instead of by a
 * worker recording an expense by hand.
 *
 * @param {string} reason
 * @returns {boolean}
 */
const isPolicyMovementReason = (module.exports.isPolicyMovementReason =
  function isPolicyMovementReason(reason) {
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text) return false;
    return POLICY_MOVEMENT_REASON_PREFIXES.some((prefix) =>
      text.startsWith(prefix)
    );
  });

/**
 * Whether a cash-ledger row is money HANDED OVER to a person (Type =
 * 'handover') instead of an increase or an expense.
 *
 * @param {string} type
 * @returns {boolean}
 */
const isCashHandover = (module.exports.isCashHandover = function isCashHandover(
  type
) {
  return String(type || "").trim().toLowerCase() === HANDOVER_TYPE;
});

/**
 * Whether a cash-ledger row is money coming BACK from a hand-over (Type =
 * 'handover_return') instead of an increase or an expense.
 *
 * @param {string} type
 * @returns {boolean}
 */
const isHandoverReturn = (module.exports.isHandoverReturn =
  function isHandoverReturn(type) {
    return String(type || "").trim().toLowerCase() === HANDOVER_RETURN_TYPE;
  });

/**
 * Split one day's `cash_transactions` rows into the branch's EXPENCES - the
 * manual reductions only - and their per-currency total. Refunds of annulled or
 * deleted insurances and the corrections of edited policies are left out: they
 * are policy movements, not money the branch spent. Hand-overs and their
 * returns are different ledger types, so they are left out as well.
 *
 * @param {object[]} rows  The day's `cash_transactions` rows.
 * @returns {{ expences: object[], totalExpences: Record<string, number> }}
 */
const splitExpences = (module.exports.splitExpences =
  function splitExpences(rows) {
    const expences = (rows || []).filter(
      (row) =>
        String(row.Type || "").toLowerCase() === "reduce" &&
        !isPolicyMovementReason(row.Reason)
    );
    const totalExpences = {};
    for (const currency of CURRENCIES) totalExpences[currency] = 0;
    for (const row of expences) {
      const cur = normalizeCurrency(row.Currency);
      totalExpences[cur] =
        Math.round((totalExpences[cur] + (Number(row.Amount) || 0)) * 100) / 100;
    }
    return { expences, totalExpences };
  });

// ---------------------------------------------------------------------------
// Hand-over statistics and returns (admin only)
//
// The Current cash screen shows an admin how much money is out of the company
// because it was handed to a person, and how much of it has come back:
//
//   cash.handedOver         live cash hand-overs (Type = 'handover')
//   cash.undone             hand-overs that were DELETED (their money went
//                           back to the drawer in full)
//   cash.returnedToDrawer   returns whose Destination = 'drawer'
//   cash.returnedToBank     returns whose Destination = 'bank'
//   cash.outstanding        live hand-overs minus both kinds of return
//   balance.handedOver      live broker-balance hand-overs ('handover' rows of
//                           broker_balance_movements; these carry no branch)
//   balance.undone          broker hand-overs deleted from the broker history
//   balance.outstanding     live broker hand-overs (not returnable here)
//
// `handovers` lists only the live cash hand-overs that still have money out,
// newest first, so the screen can offer "Undo" for each of them. The figures
// are per currency and cover every branch (a broker hand-over has no branch).
// ---------------------------------------------------------------------------

const emptyCashTotals = () => {
  const totals = {};
  for (const currency of CURRENCIES) totals[currency] = 0;
  return totals;
};

/**
 * Sum one grouped-by-currency query into a { EUR, TRY } object.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} sql  Query returning `Currency` and `Total` columns.
 * @param {unknown[]} [params]
 * @returns {Promise<Record<string, number>>}
 */
async function sumHandoverTotals(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  const totals = emptyCashTotals();
  for (const row of rows || []) {
    const cur = normalizeCurrency(row.Currency);
    totals[cur] = roundMoney(totals[cur] + (Number(row.Total) || 0));
  }
  return totals;
}

/**
 * Read the company-wide hand-over statistics (see the block above).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<object>}
 */
const getHandoverStats = (module.exports.getHandoverStats =
  async function getHandoverStats(conn) {
    const [cashHandedOver, cashUndone, cashReturnedDrawer, cashReturnedBank] =
      await Promise.all([
        sumHandoverTotals(
          conn,
          `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
             FROM cash_transactions
            WHERE Type = 'handover' AND Deleted = 0
            GROUP BY Currency`
        ),
        sumHandoverTotals(
          conn,
          `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
             FROM cash_transactions
            WHERE Type = 'handover' AND Deleted = 1
            GROUP BY Currency`
        ),
        sumHandoverTotals(
          conn,
          `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
             FROM cash_handover_returns
            WHERE HandoverType = 'cash' AND Destination = 'drawer'
            GROUP BY Currency`
        ),
        sumHandoverTotals(
          conn,
          `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
             FROM cash_handover_returns
            WHERE HandoverType = 'cash' AND Destination = 'bank'
            GROUP BY Currency`
        ),
      ]);

    const [balanceHandedOver, balanceUndone] = await Promise.all([
      sumHandoverTotals(
        conn,
        `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
           FROM broker_balance_movements
          WHERE Type = 'handover' AND Deleted = 0
          GROUP BY Currency`
      ),
      sumHandoverTotals(
        conn,
        `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
           FROM broker_balance_movements
          WHERE Type = 'handover' AND Deleted = 1
          GROUP BY Currency`
      ),
    ]);

    // Every live cash hand-over with the money already returned, so the screen
    // can show the remaining amount and offer to return it. A hand-over that
    // has been fully returned is left out: there is nothing left to undo.
    const [handoverRows] = await conn.query(
      `SELECT h.id, h.Branch, h.Amount, h.Currency, h.Username, h.Reason,
              h.Recipient, h.CreatedAt, COALESCE(r.Returned, 0) AS Returned
         FROM cash_transactions h
         LEFT JOIN (
           SELECT CashTransactionId, ROUND(SUM(Amount), 2) AS Returned
             FROM cash_handover_returns
            WHERE HandoverType = 'cash'
            GROUP BY CashTransactionId
         ) r ON r.CashTransactionId = h.id
        WHERE h.Type = 'handover' AND h.Deleted = 0
        ORDER BY h.id DESC`
    );
    const handovers = [];
    for (const row of handoverRows || []) {
      const amount = roundMoney(row.Amount);
      const returned = roundMoney(row.Returned);
      const remaining = roundMoney(amount - returned);
      if (remaining <= 0) continue;
      handovers.push({
        id: Number(row.id),
        Branch: row.Branch,
        Amount: amount,
        Currency: normalizeCurrency(row.Currency),
        Username: row.Username,
        Reason: row.Reason,
        Recipient: row.Recipient,
        CreatedAt: row.CreatedAt,
        Returned: returned,
        Remaining: remaining,
      });
    }

    const cashOutstanding = emptyCashTotals();
    for (const currency of CURRENCIES) {
      cashOutstanding[currency] = roundMoney(
        Math.max(
          0,
          cashHandedOver[currency] -
            cashReturnedDrawer[currency] -
            cashReturnedBank[currency]
        )
      );
    }

    return {
      cash: {
        handedOver: cashHandedOver,
        undone: cashUndone,
        returnedToDrawer: cashReturnedDrawer,
        returnedToBank: cashReturnedBank,
        outstanding: cashOutstanding,
      },
      balance: {
        handedOver: balanceHandedOver,
        undone: balanceUndone,
        outstanding: { ...balanceHandedOver },
      },
      handovers,
    };
  });

/**
 * Return (part of) a cash hand-over: the money that was given to a person comes
 * back. The admin chooses where it goes:
 *
 *   - destination 'drawer': the drawer is increased through a
 *     `cash_transactions` row of Type = 'handover_return'. Like a hand-over it
 *     writes NO Total cash row, so Total daily cash and the expenses stay
 *     untouched, but the drawer's historical walk follows the money.
 *   - destination 'bank': nothing but `cash_handover_returns` is written - no
 *     drawer moves, the handed-over total simply falls.
 *
 * A hand-over can be returned in parts; the sum of its returns can never exceed
 * the amount that was handed over.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {object} handover  The `cash_transactions` row being returned.
 * @param {string} username
 * @param {number|string} amount
 * @param {"drawer"|"bank"} destination
 * @param {string} [reason]  Optional note from the admin.
 * @param {string} [createdAt]
 * @returns {Promise<object>}
 */
const recordCashHandoverReturn = (module.exports.recordCashHandoverReturn =
  async function recordCashHandoverReturn(
    conn,
    handover,
    username,
    amount,
    destination,
    reason,
    createdAt
  ) {
    if (!handover || !isCashHandover(handover.Type)) {
      const err = new Error("transaction is not a hand-over");
      err.status = 400;
      throw err;
    }
    if (Number(handover.Deleted)) {
      const err = new Error("a deleted hand-over cannot be returned");
      err.status = 400;
      throw err;
    }

    const dest = String(destination || "")
      .trim()
      .toLowerCase();
    if (!HANDOVER_RETURN_DESTINATIONS.includes(dest)) {
      const err = new Error("destination must be 'drawer' or 'bank'");
      err.status = 400;
      throw err;
    }

    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) {
      const err = new Error("amount must be a positive number");
      err.status = 400;
      throw err;
    }

    const [returnedRows] = await conn.query(
      `SELECT COALESCE(SUM(Amount), 0) AS Returned
         FROM cash_handover_returns
        WHERE HandoverType = 'cash' AND CashTransactionId = ?`,
      [handover.id]
    );
    const returnedSoFar = roundMoney(
      returnedRows && returnedRows[0] ? returnedRows[0].Returned : 0
    );
    const remaining = roundMoney(roundMoney(handover.Amount) - returnedSoFar);
    if (remaining <= 0) {
      const err = new Error("the hand-over has already been fully returned");
      err.status = 400;
      throw err;
    }
    if (decimal > remaining + 0.005) {
      const err = new Error("amount exceeds the money still handed over");
      err.status = 400;
      throw err;
    }

    const b = normalizeBranch(handover.Branch);
    const cur = normalizeCurrency(handover.Currency);
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);
    const note = typeof reason === "string" ? reason.trim() : "";
    const ledgerReason = (
      `Return of hand over #${handover.id}` + (note ? `: ${note}` : "")
    ).slice(0, 255);

    let returnTransactionId = null;
    if (dest === "drawer") {
      await adjustBalance(conn, b, cur, "increase", decimal);
      const [inserted] = await conn.query(
        `INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, Recipient, CreatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b,
          HANDOVER_RETURN_TYPE,
          decimal,
          cur,
          username,
          ledgerReason,
          null,
          ts,
        ]
      );
      returnTransactionId =
        inserted && inserted.insertId ? Number(inserted.insertId) : null;
      // Deliberately no logTotalCash(): returning handed-over money is not a
      // sale and not a payment through any channel.
    }

    const [insertedReturn] = await conn.query(
      `INSERT INTO cash_handover_returns
         (HandoverType, CashTransactionId, BrokerMovementId, CashReturnTransactionId,
          Branch, BrokerId, Currency, Amount, Destination, Username, Reason, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "cash",
        Number(handover.id),
        null,
        returnTransactionId,
        b,
        null,
        cur,
        decimal,
        dest,
        username,
        note.slice(0, 255),
        ts,
      ]
    );

    return {
      id: Number(handover.id),
      amount: decimal,
      currency: cur,
      branch: b,
      destination: dest,
      returned: roundMoney(returnedSoFar + decimal),
      remaining: roundMoney(remaining - decimal),
      returnId:
        insertedReturn && insertedReturn.insertId
          ? Number(insertedReturn.insertId)
          : null,
      returnTransactionId,
    };
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
 * @param {string} [createdAt]  Client's local wall-clock time
 *   ("YYYY-MM-DD HH:MM:SS"). Defaults to the server's UTC clock.
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
    source,
    createdAt
  ) {
    const decimal = toDecimal(amount);
    if (decimal === null || decimal <= 0) return null;
    if (type !== "increase" && type !== "reduce") {
      throw new Error("type must be 'increase' or 'reduce'");
    }
    const src = CASH_SOURCES.includes(source) ? source : "Cash";
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    await conn.query(
      `INSERT INTO total_cash_transactions (Branch, Type, Amount, Currency, Source, Username, Reason, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizeBranch(branch),
        type,
        decimal,
        normalizeCurrency(currency),
        src,
        username,
        String(reason ?? "").trim(),
        ts,
      ]
    );

    return decimal;
  });

/**
 * Record a payment that arrives through the Card or the Broker channel.
 *
 * Card: the money is held in the branch's row of `branch_card_balance`, and
 * CardPart keeps the per-branch/per-currency share of it that Total cash adds
 * on top of current cash.
 *
 * Broker: an insurance created from a broker's email is funded by that broker's
 * balance (see decreaseBrokerForInsurance in Brokers.js). The money was already
 * handed over when the broker topped up (it is the branch's Cash from Brokers),
 * so current cash must NOT be increased - the payment is recorded here only.
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
 * @param {string} [createdAt]  Client's local wall-clock time
 *   ("YYYY-MM-DD HH:MM:SS"). Defaults to the server's UTC clock.
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
    source,
    createdAt
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
      source,
      createdAt
    );

    return decimal;
  });

/**
 * Move a policy's standing money from one branch to another AND re-branch its
 * ledger rows so the policy's history follows it.
 *
 * Used when a policy's Branch is edited. The old approach wrote a fresh
 * "reduce @ old branch" + "increase @ new branch" pair, which left the policy's
 * ORIGINAL entries stranded under the old branch (e.g. the creation "increase"
 * kept showing in the branch the policy no longer belongs to). Instead, the
 * existing ledger rows are re-pointed at the new branch and the balances are
 * transferred in one step.
 *
 * Balance side (per channel):
 *   Cash   -> `current_cash` of both branches.
 *   Card   -> `branch_card_balance` + the Card part of `total_cash`.
 *   Broker -> the Broker part of `total_cash`.
 *
 * Rows are matched by `Reason` against the values the policy's own movements
 * are recorded under ("<blanc>", "Edit <blanc>", "Annul <blanc>", …), so only
 * that policy's history moves and other policies are untouched.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {"Cash"|"Card"|"Broker"} payment  Channel the policy was paid through.
 * @param {object} m
 * @param {string} m.fromBranch  Branch the policy currently belongs to.
 * @param {string} m.toBranch    Branch the policy is moving to.
 * @param {number|string} m.amount  The policy's standing contribution.
 * @param {string} m.reason  The policy's blank number (identifies its rows).
 * @param {string} [m.currency]
 */
const movePolicyBranch = (module.exports.movePolicyBranch =
  async function movePolicyBranch(conn, payment, m) {
    const { fromBranch, toBranch, amount, reason, currency } = m;
    const from = normalizeBranch(fromBranch);
    const to = normalizeBranch(toBranch);
    const cur = normalizeCurrency(currency);

    // Transfer the balance the policy still contributes, through its channel.
    const decimal = toDecimal(amount);
    if (decimal !== null && decimal > 0) {
      if (payment === "Cash") {
        await adjustBalance(conn, from, cur, "reduce", decimal);
        await adjustBalance(conn, to, cur, "increase", decimal);
      } else if (payment === "Card") {
        await adjustBranchCardBalance(conn, from, "reduce", decimal);
        await adjustBranchCardBalance(conn, to, "increase", decimal);
        await adjustTotalPart(conn, from, cur, "CardPart", "reduce", decimal);
        await adjustTotalPart(conn, to, cur, "CardPart", "increase", decimal);
      } else {
        await adjustTotalPart(conn, from, cur, "BrokerPart", "reduce", decimal);
        await adjustTotalPart(conn, to, cur, "BrokerPart", "increase", decimal);
      }
    }

    // Re-point the policy's ledger rows at the new branch. Every movement the
    // policy produced carries one of these Reason values.
    const n = String(reason ?? "").trim();
    const reasons = [n, `Edit ${n}`, `Annul ${n}`, `Delete ${n}`, `Restore ${n}`];

    // Cash movements live in both ledgers; Card/Broker only in the total one.
    if (payment === "Cash") {
      await conn.query(
        `UPDATE cash_transactions SET Branch = ? WHERE Branch = ? AND Reason IN (?, ?, ?, ?, ?)`,
        [to, from, ...reasons]
      );
    }
    await conn.query(
      `UPDATE total_cash_transactions SET Branch = ? WHERE Branch = ? AND Reason IN (?, ?, ?, ?, ?)`,
      [to, from, ...reasons]
    );
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
  async function zeroAllCardParts(conn, username, createdAt) {
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);
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
        "Card",
        ts
      );
    }

    await conn.query("UPDATE total_cash SET CardPart = 0");
    return removed;
  });

// ---------------------------------------------------------------------------
// Card balance, per branch.
//
// Card payments used to be held in one global `CardBalance` row, so resetting
// a branch could never clear "its" card money. They are now held per branch in
// `branch_card_balance` (one row per branch), and resetting a branch's current
// cash also clears that branch's card balance. The per-branch/per-currency
// CardPart in `total_cash` keeps mirroring it, so Total cash stays consistent.
// The legacy `CardBalance` table is no longer read or written.
// ---------------------------------------------------------------------------

/**
 * Ensure the card balance row exists for a branch.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 */
const ensureBranchCardRow = (module.exports.ensureBranchCardRow =
  async function ensureBranchCardRow(conn, branch) {
    await conn.query(
      "INSERT IGNORE INTO branch_card_balance (Branch, CardBalance) VALUES (?, 0)",
      [normalizeBranch(branch)]
    );
  });

/**
 * Read one branch's card balance.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<number>}
 */
const getBranchCardBalance = (module.exports.getBranchCardBalance =
  async function getBranchCardBalance(conn, branch) {
    const [rows] = await conn.query(
      "SELECT CardBalance FROM branch_card_balance WHERE Branch = ?",
      [normalizeBranch(branch)]
    );
    return rows.length ? Number(rows[0].CardBalance) : 0;
  });

/**
 * Add to / subtract from one branch's card balance. Like the old global card
 * balance it may go negative (refunds are never blocked).
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {"increase"|"reduce"} type
 * @param {number} amount  Positive, already validated.
 */
const adjustBranchCardBalance = (module.exports.adjustBranchCardBalance =
  async function adjustBranchCardBalance(conn, branch, type, amount) {
    if (type !== "increase" && type !== "reduce") {
      throw new Error("type must be 'increase' or 'reduce'");
    }
    const b = normalizeBranch(branch);
    await ensureBranchCardRow(conn, b);
    await conn.query(
      "UPDATE branch_card_balance SET CardBalance = CardBalance + ? WHERE Branch = ?",
      [type === "increase" ? amount : -amount, b]
    );
  });

/**
 * Zero one branch's card balance: records the kept amount in `card_resets`
 * and zeroes the branch's CardPart in `total_cash` (logging it in the Total
 * cash ledger), so Total cash falls by the same amount.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {string} [createdAt]  Client's local wall-clock time. Defaults to the
 *   server's UTC clock.
 * @returns {Promise<number>} The card balance kept (just before zeroing).
 */
const resetBranchCard = (module.exports.resetBranchCard =
  async function resetBranchCard(conn, branch, username, createdAt) {
    const b = normalizeBranch(branch);
    await ensureBranchCardRow(conn, b);
    const kept = await getBranchCardBalance(conn, b);
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    await conn.query(
      "UPDATE branch_card_balance SET CardBalance = 0 WHERE Branch = ?",
      [b]
    );
    await conn.query(
      "INSERT INTO card_resets (Branch, Username, KeptAmount, CreatedAt) VALUES (?, ?, ?, ?)",
      [b, username, kept, ts]
    );

    const [parts] = await conn.query(
      "SELECT Currency, CardPart FROM total_cash WHERE id = ? AND Branch = ? AND CardPart != 0",
      [TOTAL_ROW_ID, b]
    );
    for (const row of parts) {
      const part = Number(row.CardPart);
      // A part can be negative after reversals; log the movement in the
      // direction that brings it back to 0.
      await logTotalCash(
        conn,
        b,
        username,
        part >= 0 ? "reduce" : "increase",
        Math.abs(part),
        "Card balance cleared",
        row.Currency,
        "Card",
        ts
      );
    }
    await conn.query(
      "UPDATE total_cash SET CardPart = 0 WHERE id = ? AND Branch = ?",
      [TOTAL_ROW_ID, b]
    );

    return kept;
  });

// ---------------------------------------------------------------------------
// Cash from brokers, per branch.
//
// When a broker hands over money their balance is increased
// (POST /brokers/:id/increase in Brokers.js). That money used to be mirrored
// into current cash; it is now kept apart as the branch's "Cash from Brokers".
//
// It is not stored as a running total. Every top-up is already a row in
// `broker_balance_movements` (Type = 'increase') carrying the branch that took
// the money and its currency, so the balance is computed on every read as the
// branch's top-ups recorded after its last reset. The balance and the
// "Transactions cash from brokers" list are therefore the same data: a top-up
// an admin corrects or deletes in the broker's history is corrected here too.
//
// Only manual top-ups count. The other movements that raise a broker balance -
// the refund of an annulled or deleted insurance, a price change, an admin
// adjustment - are not money handed over, and carry no branch.
//
// "Reset to 0" hands the branch's money over, so it clears this balance too:
// `broker_cash_resets` records what was kept and the id of the last movement
// the reset covered (movement ids, unlike the client-supplied CreatedAt, are
// strictly ordered).
// ---------------------------------------------------------------------------

// The movements that are cash handed over by a broker (`m` = the movement).
const BROKER_CASH_WHERE =
  "m.Type = 'increase' AND m.Deleted = 0 AND m.Amount > 0";

/**
 * Id of the last broker movement covered by a branch's most recent cash-from-
 * brokers reset (0 when the branch was never reset).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Already normalised.
 * @returns {Promise<number>}
 */
async function brokerCashResetMarker(conn, branch) {
  const [rows] = await conn.query(
    "SELECT COALESCE(MAX(LastMovementId), 0) AS Marker FROM broker_cash_resets WHERE Branch = ?",
    [branch]
  );
  return rows.length ? Number(rows[0].Marker) || 0 : 0;
}

/**
 * Sum a branch's broker top-ups per currency, for the movements after
 * `afterId` and (when given) up to and including `throughId`.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch  Already normalised.
 * @param {number} afterId
 * @param {number} [throughId]
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, TRY: 0 }
 */
async function sumBrokerCash(conn, branch, afterId, throughId) {
  const bounded = throughId !== undefined;
  const upper = bounded ? " AND m.id <= ?" : "";
  const [rows] = await conn.query(
    `SELECT m.Currency, ROUND(SUM(m.Amount), 2) AS Total
       FROM broker_balance_movements m
      WHERE ${BROKER_CASH_WHERE} AND m.Branch = ? AND m.id > ?${upper}
      GROUP BY m.Currency`,
    bounded ? [branch, afterId, throughId] : [branch, afterId]
  );
  const totals = {};
  for (const currency of CURRENCIES) totals[currency] = 0;
  for (const row of rows) {
    const cur = normalizeCurrency(row.Currency);
    totals[cur] =
      Math.round((totals[cur] + (Number(row.Total) || 0)) * 100) / 100;
  }
  return totals;
}

/**
 * Read a branch's Cash from Brokers, keyed by currency code: the money brokers
 * handed over at that branch since its last reset.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @returns {Promise<Record<string, number>>} e.g. { EUR: 0, TRY: 0 }
 */
const getBrokerCash = (module.exports.getBrokerCash =
  async function getBrokerCash(conn, branch) {
    const b = normalizeBranch(branch);
    return sumBrokerCash(conn, b, await brokerCashResetMarker(conn, b));
  });

/**
 * The broker top-ups a branch received on one day, newest first.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} date  "YYYY-MM-DD" of the day.
 * @param {string} nextDate  "YYYY-MM-DD" of the day after.
 * @returns {Promise<object[]>}
 */
const getBrokerCashTransactions = (module.exports.getBrokerCashTransactions =
  async function getBrokerCashTransactions(conn, branch, date, nextDate) {
    const [rows] = await conn.query(
      `SELECT m.id, m.BrokerId, b.Name AS BrokerName, m.Amount, m.Currency,
              m.Author AS Username, m.Reason, m.CreatedAt
         FROM broker_balance_movements m
         LEFT JOIN brokers b ON b.id = m.BrokerId
        WHERE ${BROKER_CASH_WHERE} AND m.Branch = ?
          AND m.CreatedAt >= ? AND m.CreatedAt < ?
        ORDER BY m.id DESC`,
      [normalizeBranch(branch), date, nextDate]
    );
    return rows;
  });

/**
 * Clear a branch's Cash from Brokers and record who did it and how much was
 * kept per currency. Nothing is recorded for a currency with nothing to keep.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {string} [createdAt]  Client's local wall-clock time. Defaults to the
 *   server's UTC clock.
 * @returns {Promise<Record<string, number>>} Kept amount per currency.
 */
const resetBrokerCash = (module.exports.resetBrokerCash =
  async function resetBrokerCash(conn, branch, username, createdAt) {
    const b = normalizeBranch(branch);
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

    // The reset covers the movements recorded so far. Bounding the sum by the
    // same id keeps a top-up that lands while this runs in the next period.
    const after = await brokerCashResetMarker(conn, b);
    const [last] = await conn.query(
      "SELECT COALESCE(MAX(id), 0) AS LastId FROM broker_balance_movements"
    );
    const through = Math.max(
      after,
      last.length ? Number(last[0].LastId) || 0 : 0
    );
    const kept = await sumBrokerCash(conn, b, after, through);

    for (const currency of CURRENCIES) {
      if (kept[currency] === 0) continue;
      await conn.query(
        "INSERT INTO broker_cash_resets (Branch, Username, Currency, KeptAmount, LastMovementId, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [b, username, currency, kept[currency], through, ts]
      );
    }

    return kept;
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
 * @param {string} [createdAt]  Client's local wall-clock time. Defaults to the
 *   server's UTC clock.
 * @returns {Promise<Record<string, number>>} Kept amount per currency.
 */
const resetCurrentCash = (module.exports.resetCurrentCash =
  async function resetCurrentCash(conn, branch, username, createdAt) {
    const b = normalizeBranch(branch);
    await ensureAllCashRows(conn, b);
    const ts =
      typeof createdAt === "string" && createdAt.trim() !== ""
        ? createdAt.trim()
        : clientLocalDateTime(0);

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
        "INSERT INTO cash_resets (Branch, Username, Currency, KeptAmount, CreatedAt) VALUES (?, ?, ?, ?, ?)",
        [b, username, currency, kept[currency], ts]
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
        "Cash",
        ts
      );
    }

    return kept;
  });

/**
 * "Reset to 0" for a branch: zeroes the branch's current cash (every
 * currency), the branch's card balance AND its cash from brokers, recording
 * each reset.
 *
 * NOTE: runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @returns {Promise<{cash: Record<string, number>, card: number,
 *   brokerCash: Record<string, number>}>} What was kept: cash per currency,
 *   the card balance and cash from brokers per currency.
 */
const resetBranch = (module.exports.resetBranch = async function resetBranch(
  conn,
  branch,
  username,
  createdAt
) {
  const cash = await resetCurrentCash(conn, branch, username, createdAt);
  const card = await resetBranchCard(conn, branch, username, createdAt);
  const brokerCash = await resetBrokerCash(conn, branch, username, createdAt);
  return { cash, card, brokerCash };
});

/**
 * Plan an "as of" shift close for a branch: split the current cash drawer, the
 * card balance and Cash from Brokers at `cutoff`.
 *
 * The kept part of each balance is what it held at the cutoff (computed from
 * the movement timestamps); the remaining part is everything recorded after it
 * and stays live.
 *
 * Resets recorded at or after the cutoff make the split ambiguous (the balance
 * has already been handed over since), so they are refused: the admin must fix
 * the most recent open shift instead.
 *
 * Read-only: the caller applies the plan with applyBranchAsOf().
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} cutoff  "YYYY-MM-DD HH:MM:SS"
 * @returns {Promise<object|{error: string}>}
 */
const planBranchAsOf = (module.exports.planBranchAsOf =
  async function planBranchAsOf(conn, branch, cutoff) {
    const b = normalizeBranch(branch);
    const cut = parseClientDateTime(cutoff);
    if (!cut) {
      return { error: "Cutoff must be in YYYY-MM-DD HH:MM:SS format" };
    }
    const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
    const zero = () => {
      const out = {};
      for (const currency of CURRENCIES) out[currency] = 0;
      return out;
    };

    const [laterRows] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM cash_resets WHERE Branch = ? AND CreatedAt >= ?) AS CashResets,
         (SELECT COUNT(*) FROM card_resets WHERE Branch = ? AND CreatedAt >= ?) AS CardResets,
         (SELECT COUNT(*) FROM broker_cash_resets WHERE Branch = ? AND CreatedAt >= ?) AS BrokerResets`,
      [b, cut, b, cut, b, cut]
    );
    const later = laterRows[0] || {};
    if (
      Number(later.CashResets) ||
      Number(later.CardResets) ||
      Number(later.BrokerResets)
    ) {
      return {
        error: "A shift has already been closed at or after this cutoff",
      };
    }

    // Current cash: live balance minus the signed cash movements after the
    // cutoff (no resets after it - checked above).
    const [cashRows] = await conn.query(
      "SELECT Currency, CurrentCash FROM current_cash WHERE id = ? AND Branch = ?",
      [CASH_ROW_ID, b]
    );
    const liveCash = zero();
    for (const row of cashRows) {
      if (liveCash[row.Currency] !== undefined) {
        liveCash[row.Currency] = round2(row.CurrentCash);
      }
    }
    const [cashMoveRows] = await conn.query(
      `SELECT Currency,
              ROUND(SUM(CASE WHEN Type IN ('increase', 'handover_return') THEN Amount ELSE -Amount END), 2) AS Net
         FROM cash_transactions
        WHERE Branch = ? AND Deleted = 0 AND CreatedAt >= ?
        GROUP BY Currency`,
      [b, cut]
    );
    const cashAfter = zero();
    for (const row of cashMoveRows) {
      if (cashAfter[row.Currency] !== undefined) {
        cashAfter[row.Currency] = round2(row.Net);
      }
    }

    // Card balance: the CardPart is the per-currency share of it, so split the
    // parts and sum them back into the single branch card balance.
    const [partRows] = await conn.query(
      "SELECT Currency, CardPart FROM total_cash WHERE id = ? AND Branch = ?",
      [TOTAL_ROW_ID, b]
    );
    const liveCardPart = zero();
    for (const row of partRows) {
      if (liveCardPart[row.Currency] !== undefined) {
        liveCardPart[row.Currency] = round2(row.CardPart);
      }
    }
    const [cardMoveRows] = await conn.query(
      `SELECT Currency,
              ROUND(SUM(CASE WHEN Type = 'increase' THEN Amount ELSE -Amount END), 2) AS Net
         FROM total_cash_transactions
        WHERE Branch = ? AND Source = 'Card' AND CreatedAt >= ?
        GROUP BY Currency`,
      [b, cut]
    );
    const cardAfter = zero();
    for (const row of cardMoveRows) {
      if (cardAfter[row.Currency] !== undefined) {
        cardAfter[row.Currency] = round2(row.Net);
      }
    }

    // Cash from brokers: only manual top-ups count. Split them by CreatedAt
    // since the last reset marker; the marker advances to the last top-up that
    // belongs to the closed shift.
    const marker = await brokerCashResetMarker(conn, b);
    const [brokerLiveRows] = await conn.query(
      `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
         FROM broker_balance_movements m
        WHERE ${BROKER_CASH_WHERE} AND m.Branch = ? AND m.id > ?
        GROUP BY Currency`,
      [b, marker]
    );
    const [brokerAsOfRows] = await conn.query(
      `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
         FROM broker_balance_movements m
        WHERE ${BROKER_CASH_WHERE} AND m.Branch = ? AND m.id > ? AND m.CreatedAt < ?
        GROUP BY Currency`,
      [b, marker, cut]
    );
    const [throughRows] = await conn.query(
      `SELECT COALESCE(MAX(m.id), 0) AS ThroughId
         FROM broker_balance_movements m
        WHERE ${BROKER_CASH_WHERE} AND m.Branch = ? AND m.id > ? AND m.CreatedAt < ?`,
      [b, marker, cut]
    );
    const liveBroker = zero();
    const asOfBroker = zero();
    for (const row of brokerLiveRows) {
      if (liveBroker[row.Currency] !== undefined) {
        liveBroker[row.Currency] = round2(row.Total);
      }
    }
    for (const row of brokerAsOfRows) {
      if (asOfBroker[row.Currency] !== undefined) {
        asOfBroker[row.Currency] = round2(row.Total);
      }
    }
    const through = Math.max(
      marker,
      Number(throughRows[0] && throughRows[0].ThroughId) || 0
    );

    const kept = { cash: zero(), card: 0, brokerCash: zero() };
    const remaining = { cash: zero(), card: 0, brokerCash: zero() };
    const cardParts = { kept: zero(), remaining: zero() };
    let cardKept = 0;
    let cardRemaining = 0;

    for (const currency of CURRENCIES) {
      const cashKept = round2(liveCash[currency] - cashAfter[currency]);
      const cashRemaining = round2(cashAfter[currency]);
      if (cashRemaining < 0) {
        return {
          error: `Today's cash is below the midnight balance for ${currency}`,
        };
      }
      if (cashKept < 0) {
        return {
          error: `The cash balance at the cutoff is negative for ${currency}`,
        };
      }
      kept.cash[currency] = cashKept;
      remaining.cash[currency] = cashRemaining;

      const partKept = round2(liveCardPart[currency] - cardAfter[currency]);
      const partRemaining = round2(cardAfter[currency]);
      cardParts.kept[currency] = partKept;
      cardParts.remaining[currency] = partRemaining;
      cardKept = round2(cardKept + partKept);
      cardRemaining = round2(cardRemaining + partRemaining);

      const brokerRemaining = round2(
        liveBroker[currency] - asOfBroker[currency]
      );
      if (brokerRemaining < 0) {
        return {
          error: `Cash from brokers is below the midnight balance for ${currency}`,
        };
      }
      kept.brokerCash[currency] = asOfBroker[currency];
      remaining.brokerCash[currency] = brokerRemaining;
    }

    kept.card = cardKept;
    remaining.card = cardRemaining;
    return { kept, remaining, cardParts, brokerThrough: through, cutoff: cut };
  });

/**
 * Apply a plan produced by planBranchAsOf(). Runs inside the caller's
 * transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} username
 * @param {object} plan
 * @returns {Promise<object>} The applied plan.
 */
const applyBranchAsOf = (module.exports.applyBranchAsOf =
  async function applyBranchAsOf(conn, branch, username, plan) {
    const b = normalizeBranch(branch);
    const ts = plan.cutoff;

    await ensureAllCashRows(conn, b);
    await ensureAllTotalRows(conn, b);
    await ensureBranchCardRow(conn, b);

    for (const currency of CURRENCIES) {
      await conn.query(
        "UPDATE current_cash SET CurrentCash = ? WHERE id = ? AND Branch = ? AND Currency = ?",
        [plan.remaining.cash[currency], CASH_ROW_ID, b, currency]
      );
      await conn.query(
        "INSERT INTO cash_resets (Branch, Username, Currency, KeptAmount, CreatedAt) VALUES (?, ?, ?, ?, ?)",
        [b, username, currency, plan.kept.cash[currency], ts]
      );
      await logTotalCash(
        conn,
        b,
        username,
        "reduce",
        plan.kept.cash[currency],
        "Current cash reset (shift end)",
        currency,
        "Cash",
        ts
      );

      const partKept = plan.cardParts.kept[currency];
      await conn.query(
        "UPDATE total_cash SET CardPart = ? WHERE id = ? AND Branch = ? AND Currency = ?",
        [plan.cardParts.remaining[currency], TOTAL_ROW_ID, b, currency]
      );
      if (partKept > 0) {
        await logTotalCash(
          conn,
          b,
          username,
          "reduce",
          partKept,
          "Card balance reset (shift end)",
          currency,
          "Card",
          ts
        );
      } else if (partKept < 0) {
        await logTotalCash(
          conn,
          b,
          username,
          "increase",
          -partKept,
          "Card balance reset (shift end)",
          currency,
          "Card",
          ts
        );
      }

      if (plan.kept.brokerCash[currency] !== 0) {
        await conn.query(
          "INSERT INTO broker_cash_resets (Branch, Username, Currency, KeptAmount, LastMovementId, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)",
          [
            b,
            username,
            currency,
            plan.kept.brokerCash[currency],
            plan.brokerThrough,
            ts,
          ]
        );
      }
    }

    await conn.query(
      "UPDATE branch_card_balance SET CardBalance = ? WHERE Branch = ?",
      [plan.remaining.card, b]
    );
    await conn.query(
      "INSERT INTO card_resets (Branch, Username, KeptAmount, CreatedAt) VALUES (?, ?, ?, ?)",
      [b, username, plan.kept.card, ts]
    );

    return plan;
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

  // Who received money that was handed over. Both `Recipient` and `recipient`
  // are accepted, like the other body fields of this router.
  const recipientText = (recipient) =>
    typeof recipient === "string" ? recipient.trim() : "";

  // GET /currentcash/branches — every branch with a non-zero drawer balance.
  //
  // The balance is the SAME derived figure the Current cash screen shows (see
  // getAvailableCashAsOf): the cash policies of the open shift plus manual
  // movements. Reading the stored `current_cash` here instead would let the
  // dashboard and that screen disagree.
  //   ?tzOffset=N  the client's UTC offset, used to work out "today"
  router.get(
    "/currentcash/branches",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const day = resolveHistoryDay("", req.query.tzOffset);
        if (day.error) {
          return res.status(400).json({ error: day.error });
        }
        // Every branch ever seen (a reset or a movement creates its rows), so a
        // branch whose stored balance is 0 but whose policies still hold money
        // is not missed.
        const [rows] = await DBConnection.query(
          `SELECT DISTINCT Branch FROM current_cash ORDER BY Branch`
        );

        const branchData = {};
        for (const row of rows) {
          const branch = row.Branch;
          const balances = await getAvailableCashAsOf(
            DBConnection,
            branch,
            day.nextDate
          );
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

  // GET /currentcash — per-currency balances plus the transaction and reset
  // history of ONE day for the branch in the query string.
  //   ?branch=...    branch to read
  //   ?date=YYYY-MM-DD  day to list (any day; default: the client's today)
  //   ?tzOffset=N    client UTC offset in minutes, used to work out "today"
  router.get("/currentcash", auth, requireCashRole, async (req, res) => {
    try {
      const branch = normalizeBranch(req.query.branch);
      const day = resolveHistoryDay(req.query.date, req.query.tzOffset);
      if (day.error) {
        return res.status(400).json({ error: day.error });
      }
      const balances = await getCurrentCash(DBConnection, branch);
      const cardBalance = await getBranchCardBalance(DBConnection, branch);
      // Soft-deleted ledger rows are kept for the record but never listed: an
      // admin deleted them, so they no longer count as money of this branch.
      //
      // The LEFT JOIN tells a row written by an insurance apart from one typed
      // in by hand: the sale of a policy and the corrections of an edited,
      // annulled, deleted or restored one always carry the policy's blanc
      // number as their reason (or one of the "Edit ..." / "Annul ..." prefixes
      // recognised by isPolicyMovementReason). Those rows are bookkeeping of
      // the POLICY, not transactions of the drawer - the policy is read live
      // from `insurance` - so they never appear in the Transactions table and
      // an edited policy never shows up on the day it was edited.
      const [txs] = await DBConnection.query(
        `SELECT ct.*, p.BlancNumber AS PolicyBlanc
           FROM cash_transactions ct
           LEFT JOIN insurance p ON p.BlancNumber = ct.Reason
          WHERE ct.Branch = ? AND ct.Deleted = 0
            AND ct.CreatedAt >= ? AND ct.CreatedAt < ?
          ORDER BY ct.id DESC`,
        [branch, day.date, day.nextDate]
      );
      // `PolicyBlanc` only told the filter above which rows belong to a policy;
      // it is stripped from everything that leaves this endpoint.
      const withoutPolicy = (row) => {
        const { PolicyBlanc, ...rest } = row;
        return rest;
      };
      const transactions = txs
        .filter(
          (row) =>
            (row.PolicyBlanc === null || row.PolicyBlanc === undefined) &&
            !isPolicyMovementReason(row.Reason)
        )
        .map(withoutPolicy);
      const [resets] = await DBConnection.query(
        `SELECT * FROM cash_resets
          WHERE Branch = ? AND CreatedAt >= ? AND CreatedAt < ?
          ORDER BY id DESC`,
        [branch, day.date, day.nextDate]
      );
      // "Reset to 0" also clears the branch's card balance, recorded in
      // `card_resets`. Return it too so the Current cash screen can show the
      // card amount kept alongside the cash in its Resets table.
      const [cardResets] = await DBConnection.query(
        `SELECT * FROM card_resets
          WHERE Branch = ? AND CreatedAt >= ? AND CreatedAt < ?
          ORDER BY id DESC`,
        [branch, day.date, day.nextDate]
      );
      // Walk-in policies paid by card that belong to this branch on the picked
      // day. The Current cash screen's Card balance card opens this list, so it
      // uses the same filters as the daily cardPayments figure: a walk-in
      // (broker-less) card policy, by creation day, for this branch.
      //
      // `insurance` has NO `id` column (its primary key is `BlancNumber`), so the
      // tie-break on same-day creations must use the blanc number; ordering by
      // `id` made MySQL reject the whole Current cash lookup with
      // "Unknown column 'id' in 'ORDER BY'".
      const [cardInsurances] = await DBConnection.query(
        `SELECT * FROM insurance
          WHERE Deleted = 0
            AND PaymentType = 'Card'
            AND BrokerId IS NULL
            AND Branch = ?
            AND CreationDate >= ? AND CreationDate < ?
          ORDER BY CreationDate DESC, BlancNumber DESC`,
        [branch, day.date, day.nextDate]
      );
      // Cash from Brokers: the branch's balance, the top-ups it received on the
      // requested day, and the resets that cleared it that day.
      const brokerCash = await getBrokerCash(DBConnection, branch);
      const brokerCashTransactions = await getBrokerCashTransactions(
        DBConnection,
        branch,
        day.date,
        day.nextDate
      );
      const [brokerCashResets] = await DBConnection.query(
        `SELECT * FROM broker_cash_resets
          WHERE Branch = ? AND CreatedAt >= ? AND CreatedAt < ?
          ORDER BY id DESC`,
        [branch, day.date, day.nextDate]
      );
      // The day's EXPENCES: the manual reductions of the same ledger, i.e.
      // everything except the refunds/corrections the insurances routes wrote
      // for an annulled, deleted, restored or edited policy (see "Expences"
      // above) and except hand-overs, which are their own ledger type. They are
      // read from the rows already fetched, so the list always matches the
      // Transactions table shown next to it on the same day.
      const { expences, totalExpences } = splitExpences(txs);
      const payload = {
        balances,
        cardBalance,
        brokerCash,
        // Only the movements typed in by hand (and hand-overs): a policy's own
        // ledger rows are not transactions of the drawer (see above).
        transactions,
        expences: expences.map(withoutPolicy),
        totalExpences,
        brokerCashTransactions,
        resets,
        cardResets,
        brokerCashResets,
        cardInsurances,
        date: day.date,
      };
      // Hand-over statistics are for admins only. They are company-wide (every
      // branch and every broker), so they do not change with the branch
      // selector; the list of outstanding hand-overs names each branch.
      if (String(req.user && req.user.role) === "1") {
        payload.handoverStats = await getHandoverStats(DBConnection);
      }
      res.json(payload);
    } catch (err) {
      console.error("CurrentCash lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch current cash" });
    }
  });

  // GET /currentcash/daily — country-wide daily report for the day in the
  // query string. It is independent of the branch selector above: insurances
  // and cash movements are counted across ALL branches. When ?branch= is
  // provided, the report becomes branch-scoped: `cashPayments`,
  // `cardPayments`, `brokerBalance`, `totalDailyBalance` and `cashFromBrokers`
  // are restricted to that branch, and `availableCash` carries that branch's
  // cash drawer at the end of the requested day (so walking the date back shows
  // the amount it actually had then, not today's).
  //
  // Every money figure is the price of the policies CREATED on that day, split
  // by the channel they were paid through:
  //   cashPayments       walk-in cash policies (the drawer)
  //   cardPayments       walk-in card policies (the card balance)
  //   brokerBalance      policies funded from a broker's balance
  //   totalDailyBalance  all of them together - the day's total insurance money
  //   cashFromBrokers    broker balance top-ups (money handed over by brokers)
  //   availableCash      the branch's drawer at the end of the day
  //   ?date=YYYY-MM-DD  day to report on (default: the client's today)
  //   ?tzOffset=N       client UTC offset in minutes, used to work out "today"
  //   ?branch=...       branch the figures above belong to
  router.get("/currentcash/daily", auth, requireCashRole, async (req, res) => {
    try {
      const day = resolveHistoryDay(req.query.date, req.query.tzOffset);
      if (day.error) {
        return res.status(400).json({ error: day.error });
      }
      const branch = normalizeBranch(req.query.branch);

      // Every non-deleted insurance created that day, split by channel: a
      // broker-linked (email) policy has a BrokerId, a walk-in has none.
      const [counts] = await DBConnection.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN BrokerId IS NOT NULL THEN 1 ELSE 0 END), 0) AS broker,
           COALESCE(SUM(CASE WHEN BrokerId IS NULL THEN 1 ELSE 0 END), 0) AS walkIn
         FROM insurance
         WHERE Deleted = 0 AND CreationDate >= ? AND CreationDate < ?`,
        [day.date, day.nextDate]
      );

      // Country-wide figure via the policy-number span of the day: the last
      // policy number minus the first daily policy number (policy numbers are
      // issued sequentially).
      const [span] = await DBConnection.query(
        `SELECT
           MIN(CAST(PolicyNumber AS UNSIGNED)) AS firstPolicy,
           MAX(CAST(PolicyNumber AS UNSIGNED)) AS lastPolicy
         FROM insurance
         WHERE Deleted = 0
           AND PolicyNumber REGEXP '^[0-9]+$'
           AND CreationDate >= ? AND CreationDate < ?`,
        [day.date, day.nextDate]
      );
      const hasNumberedPolicies = !!(span[0] && span[0].firstPolicy !== null);
      const firstPolicy =
        span[0] && span[0].firstPolicy !== null ? Number(span[0].firstPolicy) : 0;
      const lastPolicy =
        span[0] && span[0].lastPolicy !== null ? Number(span[0].lastPolicy) : 0;

      // The two policies that set the ends of that range. The figure is only
      // the distance between the day's lowest and highest policy number, so a
      // single mistyped or out-of-series number at either end changes it by
      // hundreds of thousands. Returning the two records lets the screen show
      // which policies produced the number, making such an outlier obvious.
      const policyRef = (row) =>
        row
          ? {
              PolicyNumber: String(row.PolicyNumber ?? ""),
              BlancNumber: String(row.BlancNumber ?? ""),
              Branch: String(row.Branch ?? ""),
              Author: String(row.Author ?? ""),
              CreatedAt: String(row.CreatedAt ?? ""),
            }
          : null;
      const countryWideRange = { first: null, last: null };
      if (hasNumberedPolicies) {
        const edgeSql = (direction) =>
          `SELECT PolicyNumber, BlancNumber, Branch, Author,
                  DATE_FORMAT(CreationDate, '%Y-%m-%d %H:%i') AS CreatedAt
             FROM insurance
            WHERE Deleted = 0
              AND PolicyNumber REGEXP '^[0-9]+$'
              AND CreationDate >= ? AND CreationDate < ?
            ORDER BY CAST(PolicyNumber AS UNSIGNED) ${direction},
                     BlancNumber ${direction}
            LIMIT 1`;
        const [[firstRows], [lastRows]] = await Promise.all([
          DBConnection.query(edgeSql("ASC"), [day.date, day.nextDate]),
          DBConnection.query(edgeSql("DESC"), [day.date, day.nextDate]),
        ]);
        countryWideRange.first = policyRef(firstRows && firstRows[0]);
        countryWideRange.last = policyRef(lastRows && lastRows[0]);
      }

      // TOTAL DAILY BALANCE: the price of every insurance created on the day,
      // whatever it was paid with - cash, card or a broker's balance. It is the
      // day's total business figure and is deliberately NOT the net of the
      // drawer ledger (manual increases and expenses are not insurance money,
      // and an edit no longer changes the total because the policy is read at
      // its current price).
      //
      // Every money figure of the day is computed from the policies created on
      // that day (CreationDate, the client's local time). A policy's
      // contribution is its full price while active, or just the annul fee once
      // annulled; deleted policies contribute nothing. Because everything is
      // keyed on the policy's creation date, a later annulment/refund reduces
      // the figure on the day the money originally came in - it never shows up
      // as a negative on the annulment day. When a branch is supplied the
      // figures are restricted to that branch (a worker's own branch, or the
      // branch an admin selected).
      const branchFilter = branch ? " AND Branch = ?" : "";
      const branchArg = branch ? [branch] : [];
      const insuranceMoneySql = (where) =>
        `SELECT Branch, CurrencyType AS Currency,
                ${INSURANCE_AMOUNT_SQL} AS Net
           FROM insurance
          WHERE ${where} AND Deleted = 0
            AND CreationDate >= ? AND CreationDate < ?${branchFilter}
          GROUP BY Branch, CurrencyType
          ORDER BY Branch, CurrencyType`;
      // Walk-in policies paid into the drawer, walk-in policies paid by card,
      // policies funded from a broker's balance, and all of them together.
      const [[cashRows], [cardRows], [brokerRows], [allRows]] =
        await Promise.all([
          DBConnection.query(
            insuranceMoneySql("PaymentType = 'Cash' AND BrokerId IS NULL"),
            [day.date, day.nextDate, ...branchArg]
          ),
          DBConnection.query(
            insuranceMoneySql("PaymentType = 'Card' AND BrokerId IS NULL"),
            [day.date, day.nextDate, ...branchArg]
          ),
          DBConnection.query(insuranceMoneySql("BrokerId IS NOT NULL"), [
            day.date,
            day.nextDate,
            ...branchArg,
          ]),
          DBConnection.query(insuranceMoneySql("1 = 1"), [
            day.date,
            day.nextDate,
            ...branchArg,
          ]),
        ]);
      const totalDailyBalance = { EUR: 0, TRY: 0 };
      for (const row of allRows) {
        const cur = normalizeCurrency(row.Currency);
        totalDailyBalance[cur] = roundMoney(
          (totalDailyBalance[cur] || 0) + (Number(row.Net) || 0)
        );
      }
      const byBranch = (rows) => {
        const out = [];
        const index = new Map();
        for (const row of rows) {
          let entry = index.get(row.Branch);
          if (!entry) {
            entry = { Branch: row.Branch, EUR: 0, TRY: 0 };
            index.set(row.Branch, entry);
            out.push(entry);
          }
          entry[normalizeCurrency(row.Currency)] = Number(row.Net) || 0;
        }
        return out;
      };

      // Total cash from brokers: the money brokers handed over that day (top-ups
      // of a broker balance), restricted to the branch when one is supplied.
      // Top-ups recorded before this money was separated were given a branch and
      // taken out of current cash by db/separateBrokerCash.js, so past days show
      // the same split; a top-up the migration could not match stays in current
      // cash and is therefore not counted here.
      const [brokerCashRows] = await DBConnection.query(
        `SELECT m.Currency, ROUND(SUM(m.Amount), 2) AS Total
           FROM broker_balance_movements m
          WHERE ${BROKER_CASH_WHERE} AND m.Branch IS NOT NULL
            AND m.CreatedAt >= ? AND m.CreatedAt < ?${
              branch ? " AND m.Branch = ?" : ""
            }
          GROUP BY m.Currency`,
        [day.date, day.nextDate, ...branchArg]
      );
      const cashFromBrokers = { EUR: 0, TRY: 0 };
      for (const row of brokerCashRows) {
        cashFromBrokers[normalizeCurrency(row.Currency)] =
          Number(row.Total) || 0;
      }

      const report = {
        date: day.date,
        totalInsurances: Number(counts[0].total) || 0,
        brokerInsurances: Number(counts[0].broker) || 0,
        walkInInsurances: Number(counts[0].walkIn) || 0,
        // The day's insurance money, all payment types together.
        totalDailyBalance,
        countryWideInsurances: Math.max(0, lastPolicy - firstPolicy),
        countryWideRange,
        // The three channels that make up the total, one row per branch.
        cashPayments: byBranch(cashRows),
        cardPayments: byBranch(cardRows),
        brokerBalance: byBranch(brokerRows),
        cashFromBrokers,
      };

      // The selected branch's cash drawer at the end of the chosen day, derived
      // from its cash policies and manual movements (see
      // getAvailableCashAsOf), so an older date shows the amount the branch
      // actually had available then - not today's balance.
      if (branch) {
        report.availableCash = await getAvailableCashAsOf(
          DBConnection,
          branch,
          day.nextDate
        );
      }

      res.json(report);
    } catch (err) {
      console.error("CurrentCash daily report failed:", err);
      res.status(500).json({ error: "Failed to fetch daily report" });
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
        const time = resolveRequestCreatedAt(req.body);
        if (time.error) {
          return res.status(400).json({ error: time.error });
        }
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            b,
            req.user.username,
            "increase",
            amount,
            reasonText(reason),
            cur,
            time.createdAt
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
  //
  // The "Expense" button of the Current cash screen. The money leaves the
  // drawer and IS counted as an expense and in Total daily cash.
  router.post(
    "/currentcash/reduce",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency, branch } = req.body || {};
        const cur = normalizeCurrency(currency);
        const b = normalizeBranch(branch);
        const time = resolveRequestCreatedAt(req.body);
        if (time.error) {
          return res.status(400).json({ error: time.error });
        }
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashMovement(
            conn,
            b,
            req.user.username,
            "reduce",
            amount,
            reasonText(reason),
            cur,
            time.createdAt
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

  // POST /currentcash/handover
  //   { amount, reason, recipient, currency, branch }
  //
  // The "Hand over" button of the Current cash screen: money physically given to
  // a person (a runner taking the takings to the safe, the owner collecting the
  // day's cash ...). Both a reason and the name of the person who took the money
  // are required. The drawer (Available cash) drops, but the movement is NOT a
  // sale and NOT an expense: no Total cash ledger row is written and the day's
  // Total daily cash and expenses stay as they were.
  router.post(
    "/currentcash/handover",
    auth,
    requireCashRole,
    async (req, res) => {
      try {
        const { amount, reason, currency, branch } = req.body || {};
        const recipient = recipientText(
          req.body && (req.body.Recipient ?? req.body.recipient)
        );
        const cur = normalizeCurrency(currency);
        const b = normalizeBranch(branch);
        const time = resolveRequestCreatedAt(req.body);
        if (time.error) {
          return res.status(400).json({ error: time.error });
        }
        const applied = await DBConnection.withTransaction((conn) =>
          recordCashHandover(
            conn,
            b,
            req.user.username,
            amount,
            reasonText(reason),
            recipient,
            cur,
            time.createdAt
          )
        );

        res.status(201).json({
          message: "Cash handed over",
          amount: applied,
          currency: cur,
          branch: b,
          author: req.user.username,
          reason: reasonText(reason),
          recipient,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (
          msg.includes("amount") ||
          msg.includes("reason") ||
          msg.includes("recipient")
        ) {
          return res.status(400).json({ error: msg });
        }
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash handover failed:", err);
        res.status(500).json({ error: "Failed to hand over the cash" });
      }
    }
  );

  // POST /currentcash/handover/:id/undo — admin-only "Undo hand over".
  //   { Amount?, Destination: "drawer"|"bank", Reason?, CreatedAt? }
  //
  // Returns (part of) money that was handed to a person. `Destination` decides
  // where it goes:
  //   - "drawer" increases the branch's available cash (a 'handover_return'
  //     ledger row, so the historical walk stays in step);
  //   - "bank" touches no drawer at all: it only lowers the handed-over total.
  // A hand-over may be returned in several parts; the server refuses more than
  // the amount that is still out.
  router.post(
    "/currentcash/handover/:id/undo",
    auth,
    requireRole(1),
    async (req, res) => {
      const id = Number(req.params.id);
      const body = req.body || {};
      const destination = String(
        body.Destination ?? body.destination ?? ""
      )
        .trim()
        .toLowerCase();
      if (!HANDOVER_RETURN_DESTINATIONS.includes(destination)) {
        return res
          .status(400)
          .json({ error: "destination must be 'drawer' or 'bank'" });
      }
      const time = resolveRequestCreatedAt(body);
      if (time.error) {
        return res.status(400).json({ error: time.error });
      }
      try {
        const result = await DBConnection.withTransaction(async (conn) => {
          // Lock the hand-over row so two concurrent undos cannot both pass the
          // "still handed over" check and return more than was handed over.
          const [rows] = await conn.query(
            "SELECT * FROM cash_transactions WHERE id = ? FOR UPDATE",
            [id]
          );
          if (!Number.isInteger(id) || rows.length === 0) {
            const err = new Error("Transaction not found");
            err.status = 404;
            throw err;
          }
          return recordCashHandoverReturn(
            conn,
            rows[0],
            req.user.username,
            body.Amount ?? body.amount,
            destination,
            reasonText(body.Reason ?? body.reason),
            time.createdAt
          );
        });

        res.json({
          message: "Hand-over returned",
          ...result,
          author: req.user.username,
        });
      } catch (err) {
        if (err && err.status) {
          return res.status(err.status).json({ error: err.message });
        }
        const msg = (err && err.message) || "";
        if (
          msg.includes("amount") ||
          msg.includes("destination") ||
          msg.includes("hand-over") ||
          msg.includes("Transaction")
        ) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash handover return failed:", err);
        res.status(500).json({ error: "Failed to return the handed over cash" });
      }
    }
  );

  // POST /currentcash/reset — "Reset to 0": zero all currencies, the card
  // balance AND the cash from brokers of a branch, recording each reset.
  // Expects { branch } in the body.
  router.post("/currentcash/reset", auth, requireCashRole, async (req, res) => {
    try {
      const { branch } = req.body || {};
      const b = normalizeBranch(branch);
      const time = resolveRequestCreatedAt(req.body);
      if (time.error) {
        return res.status(400).json({ error: time.error });
      }
      const { cash, card, brokerCash } = await DBConnection.withTransaction(
        (conn) => resetBranch(conn, b, req.user.username, time.createdAt)
      );

      res.status(200).json({
        message: "Current cash, card balance and cash from brokers reset",
        kept: cash,
        cardKept: card,
        brokerCashKept: brokerCash,
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
        // A deleted entry was already undone (its money was moved back), so
        // there is nothing left to correct.
        if (tx.Deleted) {
          return res.status(400).json({ error: "Transaction already deleted" });
        }
        // A hand-over RETURN is a bookkeeping row created by the undo action.
        // It has no editable fields; correcting it would detach it from the
        // hand-over it belongs to.
        if (isHandoverReturn(tx.Type)) {
          return res
            .status(400)
            .json({ error: "a hand-over return cannot be edited or deleted" });
        }
        if (String(tx.Username) !== String(req.user.username)) {
          return res.status(403).json({
            error: "Forbidden: you can only edit your own transactions",
          });
        }

        const b = req.body || {};
        // Keep the stored value canonical: a hand-over is always exactly
        // "handover", whatever casing the caller sent.
        const requestedType = b.Type ?? b.type ?? tx.Type;
        const newType = isCashHandover(requestedType)
          ? HANDOVER_TYPE
          : requestedType;
        const newCurrency = normalizeCurrency(
          b.Currency ?? b.currency ?? tx.Currency
        );
        const newAmount = toDecimal(b.Amount ?? b.amount ?? tx.Amount);
        const newReason = reasonText(b.Reason ?? b.reason ?? tx.Reason);
        const newRecipient = recipientText(
          b.Recipient ?? b.recipient ?? tx.Recipient
        );
        // Branch is preserved from the original transaction.
        const txBranch = normalizeBranch(tx.Branch);

        const oldIsHandover = isCashHandover(tx.Type);
        const newIsHandover = isCashHandover(newType);

        if (newType !== "increase" && newType !== "reduce" && !newIsHandover) {
          return res
            .status(400)
            .json({ error: "type must be 'increase', 'reduce' or 'handover'" });
        }
        // An entry may be corrected, but not turned into a different KIND of
        // movement: an expense counted in Total daily cash cannot silently
        // become a hand-over (or the other way round) without a matching
        // Total cash correction, and each screen lists them separately.
        if (oldIsHandover !== newIsHandover) {
          return res.status(400).json({
            error:
              "a hand-over cannot be changed into an increase or an expense, or the other way round",
          });
        }
        if (newAmount === null || newAmount <= 0) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }
        if (!newReason) {
          return res.status(400).json({ error: "reason is required" });
        }
        if (newIsHandover && !newRecipient) {
          return res.status(400).json({ error: "recipient is required" });
        }
        // A hand-over that already has returns cannot be corrected below what
        // has come back: the remaining amount would go negative.
        if (oldIsHandover) {
          const [returnRows] = await DBConnection.query(
            `SELECT COALESCE(SUM(Amount), 0) AS Returned
               FROM cash_handover_returns
              WHERE HandoverType = 'cash' AND CashTransactionId = ?`,
            [id]
          );
          const returnedAmount = roundMoney(
            returnRows && returnRows[0] ? returnRows[0].Returned : 0
          );
          if (newAmount + 0.005 < returnedAmount) {
            return res
              .status(400)
              .json({ error: "amount is below what was already returned" });
          }
        }

        const oldType = tx.Type;
        const oldCurrency = normalizeCurrency(tx.Currency);
        const oldAmount = Number(tx.Amount);

        // The correction's own ledger entries are stamped with the client's
        // local time (the original transaction keeps its CreatedAt).
        const time = resolveRequestCreatedAt(req.body);
        if (time.error) {
          return res.status(400).json({ error: time.error });
        }

        // adjustBalance only knows "increase" and "reduce": both an expense and
        // a hand-over take money out of the drawer, so they both reduce it.
        const balanceType = (type) =>
          isCashHandover(type) ? "reduce" : type;

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
          await adjustBalance(
            conn,
            txBranch,
            newCurrency,
            balanceType(newType),
            newAmount
          );

          // Mirror the correction into the Total cash ledger. Total cash reads
          // CurrentCash live so its balance is already correct; these rows keep
          // the two records of cash flow listing the same movements. A hand-over
          // never has a row in that ledger (see recordCashHandover), so it gets
          // no correction row either - otherwise Total daily cash would gain or
          // lose money that never passed through a payment channel.
          if (!oldIsHandover && !newIsHandover) {
            await logTotalCash(
              conn,
              txBranch,
              req.user.username,
              oldType === "increase" ? "reduce" : "increase",
              oldAmount,
              `Correction of cash transaction #${id}`,
              oldCurrency,
              "Cash",
              time.createdAt
            );
            await logTotalCash(
              conn,
              txBranch,
              req.user.username,
              newType,
              newAmount,
              `Correction of cash transaction #${id}`,
              newCurrency,
              "Cash",
              time.createdAt
            );
          }

          await conn.query(
            `UPDATE cash_transactions
             SET Type = ?, Amount = ?, Currency = ?, Reason = ?, Recipient = ?
             WHERE id = ?`,
            [
              newType,
              newAmount,
              newCurrency,
              newReason,
              newRecipient || null,
              id,
            ]
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
          msg.includes("type") ||
          msg.includes("recipient") ||
          msg.includes("hand-over")
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

  // DELETE /currentcash/transactions/:id — soft-delete a ledger entry.
  //
  // Admin-only. The row is never physically removed: it is flagged with
  // Deleted/DeletedAt/DeletedBy, so the record of what happened is kept, but it
  // is excluded from every read (`GET /currentcash`, the expenses of the day,
  // the daily report and the historical balance walk) from then on.
  //
  // Deleting a ledger entry undoes it, exactly like the correction in PATCH
  // does: the drawer is moved in the opposite direction (an increase is taken
  // back off, a reduction or a hand-over is put back in) and the matching row is
  // written to the Total cash ledger, so both records of cash flow still list
  // the same movements. A hand-over has no Total cash row to reverse, so only
  // the drawer is corrected for it. The reversal is dated with the client's
  // local wall-clock time.
  //
  // A reduction whose money is no longer in the drawer (it was spent or reset
  // in between) cannot be undone: the drawer would have to go negative, so the
  // deletion is rejected and nothing changes.
  //
  // A hand-over with returns cannot be deleted either: its money was already
  // partly (or fully) put back, and deleting the row would put the whole amount
  // back again. Use "Undo hand over" for the remaining amount instead.
  router.delete(
    "/currentcash/transactions/:id",
    auth,
    requireRole(1),
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
        if (tx.Deleted) {
          return res.status(400).json({ error: "Transaction already deleted" });
        }
        // The bookkeeping row of an undo cannot be deleted: the hand-over it
        // belongs to would keep counting the money as still out.
        if (isHandoverReturn(tx.Type)) {
          return res
            .status(400)
            .json({ error: "a hand-over return cannot be edited or deleted" });
        }
        if (isCashHandover(tx.Type)) {
          const [returnRows] = await DBConnection.query(
            `SELECT COALESCE(SUM(Amount), 0) AS Returned
               FROM cash_handover_returns
              WHERE HandoverType = 'cash' AND CashTransactionId = ?`,
            [id]
          );
          const returnedAmount = roundMoney(
            returnRows && returnRows[0] ? returnRows[0].Returned : 0
          );
          if (returnedAmount > 0) {
            return res.status(400).json({
              error: "a hand-over with returns cannot be deleted",
            });
          }
        }

        const txBranch = normalizeBranch(tx.Branch);
        const currency = normalizeCurrency(tx.Currency);
        const amount = Math.abs(Number(tx.Amount) || 0);
        // The movement that undoes this entry.
        const reverseType = tx.Type === "increase" ? "reduce" : "increase";

        // The deletion is stamped with the client's local time, like every
        // other ledger row the client writes.
        const time = resolveRequestCreatedAt(req.body);
        if (time.error) {
          return res.status(400).json({ error: time.error });
        }

        await DBConnection.withTransaction(async (conn) => {
          if (amount > 0) {
            await adjustBalance(conn, txBranch, currency, reverseType, amount);

            // Total cash reads CurrentCash live, so its balance already moved
            // with adjustBalance above; this row keeps the Total cash ledger
            // listing the same movements as the cash ledger. A hand-over has no
            // row in the Total cash ledger, so undoing it must not add one
            // either - that would move Total daily cash by money that was never
            // a sale or an expense.
            if (!isCashHandover(tx.Type)) {
              await logTotalCash(
                conn,
                txBranch,
                req.user.username,
                reverseType,
                amount,
                `Delete of cash transaction #${id}`,
                currency,
                "Cash",
                time.createdAt
              );
            }
          }

          await conn.query(
            `UPDATE cash_transactions
             SET Deleted = 1, DeletedAt = ?, DeletedBy = ?
             WHERE id = ?`,
            [time.createdAt, req.user.username, id]
          );
        });

        res.json({
          message: "Transaction deleted",
          id,
          reversed: amount,
          type: reverseType,
          currency,
          branch: txBranch,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("CurrentCash transaction deletion failed:", err);
        res.status(500).json({ error: "Failed to delete transaction" });
      }
    }
  );

  // POST /currentcash/reset-asof — close a shift at a cutoff timestamp.
  // Admin-only. Splits current cash, the card balance and Cash from Brokers at
  // the cutoff: the part held at that moment is recorded as kept, and all
  // movements after it stay in the live balances.
  //   { branch, Cutoff: "YYYY-MM-DD HH:MM:SS", DryRun?: boolean }
  router.post(
    "/currentcash/reset-asof",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const body = req.body || {};
        const b = normalizeBranch(body.branch);
        const cut = parseClientDateTime(body.Cutoff ?? body.cutoff);
        if (!cut) {
          return res
            .status(400)
            .json({ error: "Cutoff must be in YYYY-MM-DD HH:MM:SS format" });
        }
        const dryRun = body.DryRun === true || body.dryRun === true;

        if (dryRun) {
          const plan = await planBranchAsOf(DBConnection, b, cut);
          if (plan.error) {
            return res.status(400).json({ error: plan.error });
          }
          return res.json({ ...plan, branch: b, cutoff: cut });
        }

        const plan = await DBConnection.withTransaction(async (conn) => {
          const p = await planBranchAsOf(conn, b, cut);
          if (p.error) {
            const err = new Error(p.error);
            err.status = 400;
            throw err;
          }
          return applyBranchAsOf(conn, b, req.user.username, p);
        });

        res.json({
          ...plan,
          branch: b,
          cutoff: cut,
          author: req.user.username,
        });
      } catch (err) {
        if (err && err.status === 400) {
          return res.status(400).json({ error: err.message });
        }
        console.error("CurrentCash as-of reset failed:", err);
        res
          .status(500)
          .json({ error: "Failed to close the shift as of the cutoff" });
      }
    }
  );

  return router;
};

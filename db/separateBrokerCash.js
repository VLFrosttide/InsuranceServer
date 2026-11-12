"use strict";
// One-time separation of historical broker top-ups from current cash.
//
// Money a broker hands over (POST /brokers/:id/increase) used to be added to the
// broker's balance AND mirrored into the branch's current cash, so it counted as
// Available cash. It now belongs to the branch's own "Cash from Brokers"
// balance: the top-up is recorded once, as a `broker_balance_movements` row of
// Type 'increase' carrying the Branch that took the money, and CurrentCash.js
// computes the balance from those rows (see "Cash from brokers, per branch").
//
// This migration makes the days before that change look the same:
//
//   1. Every manual top-up that carries no Branch yet is matched to the
//      current-cash increase it was mirrored into (`cash_transactions`): same
//      amount, same CreatedAt, same user and reason. A movement and a cash row
//      are only ever paired once, so nothing is removed twice.
//   2. The movement is given the branch and currency of the matched cash row, so
//      it appears under "Total cash from brokers" in the daily report and in the
//      "Transactions cash from brokers" list of its day.
//   3. The mirrored cash row is deleted from the drawer ledger, so that money is
//      no longer counted as cash - neither in Available cash nor in the day's
//      Total daily cash nor in the day's Transactions list.
//   4. A later "Reset to 0" had that money in the amount it kept, so its
//      KeptAmount is reduced by the broker money it contained and a matching
//      `broker_cash_resets` row is written: handing the money over cleared both
//      balances, so the branch's Cash from Brokers does not keep growing.
//   5. Whatever is still in the drawer is taken out of current_cash. The drawer
//      is never driven below zero: when the stored balance is smaller than the
//      separated money the branch has already spent part of it as cash, which is
//      reported as a warning instead of turning the balance negative.
//
// The migration runs once (marker in `app_settings`) and is idempotent anyway: a
// separated movement carries a Branch and the mirrored cash rows are gone, so
// re-running it finds nothing to do.
//
// NOTE: the caller owns the transaction. `db/setup.js` wraps the call in
// `beginTransaction` / `commit` / `rollback`.

// Name of the `app_settings` row that marks the migration as done.
const SETTING_NAME = "cash_from_brokers_backfill";

// current_cash holds one row per (id = 1, Branch, Currency), see CurrentCash.js.
const CASH_ROW_ID = 1;

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Branch as CurrentCash.js's normalizeBranch stores it. */
const branchOf = (value) =>
  value === null || value === undefined ? "" : String(value).trim();

/** Currency as CurrentCash.js's normalizeCurrency stores it. */
const currencyOf = (value) =>
  String(value === null || value === undefined ? "" : value)
    .trim()
    .toUpperCase() === "TRY"
    ? "TRY"
    : "EUR";

/**
 * Millisecond value of a DATETIME, so dates returned as JS Dates (mysql2) and as
 * "YYYY-MM-DD HH:MM:SS" strings compare the same way.
 *
 * @param {Date|string|null} value
 * @returns {number}
 */
const timeOf = (value) => {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return 0;
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

/**
 * Has the separation already run?
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<boolean>}
 */
async function isSeparated(conn) {
  const [rows] = await conn.query(
    "SELECT value FROM app_settings WHERE name = ?",
    [SETTING_NAME]
  );
  return rows.length > 0;
}

/**
 * Remember that the separation ran, so it never runs a second time.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} stamp
 */
async function markSeparated(conn, stamp) {
  await conn.query(
    `INSERT INTO app_settings (name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [SETTING_NAME, stamp]
  );
}


// A manual top-up (Type 'increase', no Branch yet, not deleted) that has a
// current-cash increase with the same amount, creation time, user and reason:
// that is the row the old increase endpoint mirrored into the drawer.
const STRICT_PAIRS_SQL = `
  SELECT m.id AS MovementId, m.Amount AS Amount, m.CreatedAt AS CreatedAt,
         t.id AS CashId, t.Branch AS Branch, t.Currency AS Currency
    FROM broker_balance_movements m
    JOIN cash_transactions t
      ON t.Type = 'increase'
     AND t.Amount = m.Amount
     AND t.CreatedAt = m.CreatedAt
     AND t.Username = m.Author
     AND t.Reason = m.Reason
   WHERE m.Type = 'increase' AND m.Branch IS NULL AND m.Deleted = 0
     AND m.Amount > 0
   ORDER BY m.id ASC, t.id ASC`;

// The same match without the reason, used for top-ups whose reason an admin
// edited afterwards. Only used when exactly one candidate is left for both the
// movement and the cash row, so an ambiguous amount is never separated.
const LOOSE_PAIRS_SQL = `
  SELECT m.id AS MovementId, m.Amount AS Amount, m.CreatedAt AS CreatedAt,
         t.id AS CashId, t.Branch AS Branch, t.Currency AS Currency
    FROM broker_balance_movements m
    JOIN cash_transactions t
      ON t.Type = 'increase'
     AND t.Amount = m.Amount
     AND t.CreatedAt = m.CreatedAt
     AND t.Username = m.Author
   WHERE m.Type = 'increase' AND m.Branch IS NULL AND m.Deleted = 0
     AND m.Amount > 0
   ORDER BY m.id ASC, t.id ASC`;

/**
 * Build the pair object stored while matching.
 *
 * @param {object} row  A row of STRICT_PAIRS_SQL / LOOSE_PAIRS_SQL.
 */
const pairOf = (row) => ({
  MovementId: Number(row.MovementId),
  CashId: Number(row.CashId),
  Branch: branchOf(row.Branch),
  Currency: currencyOf(row.Currency),
  Amount: round2(row.Amount),
  Time: timeOf(row.CreatedAt),
});

/**
 * Add the first free (movement, cash row) pairs, ignoring every candidate whose
 * movement or cash row is already taken.
 *
 * @param {object[]} rows
 * @param {Set<number>} claimedCash  Cash ids already paired.
 * @param {Map<number, object>} pairs  Movement id -> pair.
 */
function addPairs(rows, claimedCash, pairs) {
  for (const row of rows) {
    const pair = pairOf(row);
    if (pairs.has(pair.MovementId) || claimedCash.has(pair.CashId)) continue;
    if (pair.Amount <= 0) continue;
    claimedCash.add(pair.CashId);
    pairs.set(pair.MovementId, pair);
  }
}

/**
 * Second pass for top-ups whose reason was edited after the fact: pair a
 * movement with the only free cash row that still matches it, but only when that
 * cash row is the candidate of exactly one movement.
 *
 * @param {object[]} rows
 * @param {Set<number>} claimedCash
 * @param {Map<number, object>} pairs
 */
function addUniqueLoosePairs(rows, claimedCash, pairs) {
  const byMovement = new Map();
  const wantedByCash = new Map();
  for (const row of rows) {
    const pair = pairOf(row);
    if (pair.Amount <= 0) continue;
    if (pairs.has(pair.MovementId) || claimedCash.has(pair.CashId)) continue;
    if (!byMovement.has(pair.MovementId)) byMovement.set(pair.MovementId, []);
    byMovement.get(pair.MovementId).push(pair);
    wantedByCash.set(pair.CashId, (wantedByCash.get(pair.CashId) || 0) + 1);
  }
  for (const [movementId, candidates] of byMovement) {
    const free = candidates.filter((p) => !claimedCash.has(p.CashId));
    if (free.length !== 1) continue; // ambiguous - leave it as it is
    const only = free[0];
    if (wantedByCash.get(only.CashId) !== 1) continue; // ambiguous the other way
    claimedCash.add(only.CashId);
    pairs.set(movementId, only);
  }
}

/**
 * Separate one branch/currency group: re-label the movements, drop their
 * mirrored drawer rows, shorten the resets that kept that money and take what is
 * left out of the drawer.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} branch
 * @param {string} currency
 * @param {object[]} group  Pairs of one branch/currency.
 * @param {(message: string) => void} log
 * @returns {Promise<{amount: number, kept: number, drawer: number}>}
 */
async function separateGroup(conn, branch, currency, group, log) {
  const amount = round2(group.reduce((sum, p) => sum + p.Amount, 0));

  // 2) The top-up now names the branch that took the money, so it is that
  //    branch's Cash from Brokers.
  for (const pair of group) {
    await conn.query(
      "UPDATE broker_balance_movements SET Branch = ?, Currency = ? WHERE id = ?",
      [branch, currency, pair.MovementId]
    );
  }

  // 3) The money was never cash: remove the mirrored rows from the drawer
  //    ledger, so the day it arrived no longer counts it as cash.
  await conn.query("DELETE FROM cash_transactions WHERE id IN (?)", [
    group.map((p) => p.CashId),
  ]);

  // 4) A later reset kept that money as cash. Shorten it by the broker money it
  //    contained and record the same amount as a Cash from Brokers reset, so
  //    handing the money over cleared this balance too.
  const [resets] = await conn.query(
    `SELECT id, Username, KeptAmount, CreatedAt FROM cash_resets
      WHERE Branch = ? AND Currency = ?
      ORDER BY CreatedAt ASC, id ASC`,
    [branch, currency]
  );
  let kept = 0;
  let previousTime = null;
  for (const reset of resets) {
    const resetTime = timeOf(reset.CreatedAt);
    // The money this reset covered: top-ups after the previous reset (or since
    // the beginning) and up to this one.
    const covered = group.filter(
      (p) =>
        (previousTime === null || p.Time > previousTime) && p.Time <= resetTime
    );
    previousTime = resetTime;
    if (covered.length === 0) continue;

    const coveredAmount = round2(
      covered.reduce((sum, p) => sum + p.Amount, 0)
    );
    const keptAmount = round2(reset.KeptAmount);
    const keptBroker = round2(Math.min(coveredAmount, Math.max(keptAmount, 0)));
    if (keptBroker <= 0) continue;

    await conn.query("UPDATE cash_resets SET KeptAmount = ? WHERE id = ?", [
      round2(keptAmount - keptBroker),
      reset.id,
    ]);
    const lastMovementId = covered.reduce(
      (max, p) => Math.max(max, p.MovementId),
      0
    );
    const resetBy =
      reset.Username === null || reset.Username === undefined
        ? ""
        : String(reset.Username);
    await conn.query(
      `INSERT INTO broker_cash_resets
         (Branch, Username, Currency, KeptAmount, LastMovementId, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        branch,
        resetBy,
        currency,
        keptBroker,
        lastMovementId,
        reset.CreatedAt,
      ]
    );
    kept = round2(kept + keptBroker);
  }

  // 5) What no reset handed over is still sitting in the drawer.
  const remaining = round2(amount - kept);
  let drawer = 0;
  if (remaining > 0) {
    const [rows] = await conn.query(
      "SELECT CurrentCash FROM current_cash WHERE id = ? AND Branch = ? AND Currency = ?",
      [CASH_ROW_ID, branch, currency]
    );
    const current = rows.length ? round2(rows[0].CurrentCash) : 0;
    drawer = round2(Math.min(remaining, Math.max(current, 0)));
    if (drawer < remaining) {
      log(
        `Cash from brokers: ${branch || "(no branch)"} ${currency} held only ` +
          `${current} in the drawer for ${remaining} of separated broker ` +
          "money; the rest was already spent as cash"
      );
    }
    if (drawer > 0) {
      await conn.query(
        "UPDATE current_cash SET CurrentCash = CurrentCash - ? WHERE id = ? AND Branch = ? AND Currency = ?",
        [drawer, CASH_ROW_ID, branch, currency]
      );
    }
  }

  return { amount, kept, drawer };
}


/**
 * Separate every historical broker top-up from the branch cash it used to raise.
 *
 * Runs once; afterwards the marker in `app_settings` makes it a no-op. The
 * caller owns the transaction (see the file header).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {{log?: (message: string) => void, now?: Date}} [options]
 * @returns {Promise<{ran: boolean, pairs: number,
 *   groups: Array<{Branch: string, Currency: string, Amount: number,
 *                  KeptByResets: number, TakenFromDrawer: number}>}>}
 */
async function separateBrokerCash(conn, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const stamp = (options.now instanceof Date ? options.now : new Date())
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  if (await isSeparated(conn)) return { ran: false, pairs: 0, groups: [] };

  const claimedCash = new Set();
  const pairs = new Map();
  const [strictRows] = await conn.query(STRICT_PAIRS_SQL);
  addPairs(strictRows, claimedCash, pairs);
  const [looseRows] = await conn.query(LOOSE_PAIRS_SQL);
  addUniqueLoosePairs(looseRows, claimedCash, pairs);

  // Group the pairs per branch and currency; each group is corrected on its own.
  const groups = new Map();
  for (const pair of pairs.values()) {
    const key = pair.Branch + "\u0000" + pair.Currency;
    if (!groups.has(key)) {
      groups.set(key, {
        Branch: pair.Branch,
        Currency: pair.Currency,
        pairs: [],
      });
    }
    groups.get(key).pairs.push(pair);
  }

  const summary = [];
  for (const group of groups.values()) {
    const result = await separateGroup(
      conn,
      group.Branch,
      group.Currency,
      group.pairs,
      log
    );
    summary.push({
      Branch: group.Branch,
      Currency: group.Currency,
      Amount: result.amount,
      KeptByResets: result.kept,
      TakenFromDrawer: result.drawer,
    });
  }

  await markSeparated(conn, stamp);
  return { ran: true, pairs: pairs.size, groups: summary };
}

module.exports = { separateBrokerCash, SETTING_NAME };


"use strict";
// Re-attach drawer ledger rows that a blanc (blank number) correction left
// behind under the number typed first.
//
// Run from the repo root:
//   node --env-file=.env db/repair-cash-ledger-blanc.js              (report only)
//   node --env-file=.env db/repair-cash-ledger-blanc.js --apply      (write fixes)
//   node --env-file=.env db/repair-cash-ledger-blanc.js --live       (LIVE_DB_*)
//
// Why it is needed:
//
// The drawer ledger (`cash_transactions`) keys a policy's money by its blanc
// number: the sale row written when the insurance is created carries the blanc
// as its Reason, and every later drawer correction carries "Annul <blanc>",
// "Edit <blanc>", "Price change <blanc>"... When the blanc is corrected in the
// insurance editor, the server used to relabel only the broker balance history
// (`broker_balance_movements`). A WALK-IN cash policy therefore kept its sale
// row under the number typed first, and no policy had that number any more.
//
// `getAvailableCashAsOf` / `getDayCash` (Requests/CurrentCash.js) read such a
// row as money typed in BY HAND, so a day counted the policy's price twice -
// once from the live policy, once from the stranded row - and the Transactions
// list showed an increase nobody entered. The mirror row in
// `total_cash_transactions` keeps the same stale number.
//
// The server now relabels both ledgers in the same transaction as the edit (see
// PATCH /insurances/:blancNumber in Requests/TierEndpoints.js); this script
// fixes the rows written before that. A row is relabelled only when the pairing
// is unambiguous: exactly ONE policy that is a walk-in cash policy of the same
// branch, author and currency, with the same price, was created at the exact
// same second, and that policy has no sale row of its own yet. Anything else is
// listed for review.
//
// No money moves: amounts, the drawer balance (`current_cash`) and the policy
// itself are untouched - only the row's Reason changes, so the row starts
// matching its policy and is no longer counted as a manual increase.
//
// The script is idempotent. Always run it without --apply first.

const mysql = require("mysql2/promise");
const { databaseSettings } = require("./repair-broker-ledger.js");

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Find every drawer row whose numeric Reason matches no policy, with the policy
 * that row most likely belongs to (or null when the pairing is not
 * unambiguous).
 *
 * @param {{query: Function}} conn
 * @returns {Promise<Array<{row: object, target: object|null, reason: string}>>}
 */
async function findStrandedSales(conn) {
  const [rows] = await conn.query(
    `SELECT ct.id, ct.Branch, ct.Type, ct.Amount, ct.Currency,
            ct.Username, ct.Reason, ct.CreatedAt
       FROM cash_transactions ct
       LEFT JOIN insurance p ON p.BlancNumber = ct.Reason
      WHERE ct.Deleted = 0 AND ct.Reason REGEXP '^[0-9]+$'
        AND p.BlancNumber IS NULL
      ORDER BY ct.id`
  );

  const out = [];
  for (const row of rows || []) {
    const isSale = String(row.Type || "").trim().toLowerCase() === "increase";
    let target = null;
    let reason = "";

    if (!isSale) {
      reason = "not an increase - a manual entry that happens to look numeric";
    } else {
      const [candidates] = await conn.query(
        `SELECT i.BlancNumber, i.PolicyNumber, i.Deleted, i.Price,
                i.CreationDate AS CreatedAt,
                COALESCE((
                  SELECT e.Amount FROM cash_transactions e
                   WHERE e.Reason = CONCAT('Edit ', i.BlancNumber)
                     AND e.Type = 'reduce' AND e.Deleted = 0
                   ORDER BY e.id LIMIT 1
                ), 0) AS EditedFrom
           FROM insurance i
          WHERE i.CreationDate = ? AND i.Branch = ? AND i.Author = ?
            AND i.CurrencyType = ? AND i.PaymentType = 'Cash'
            AND i.BrokerId IS NULL`,
        [row.CreatedAt, row.Branch, row.Username, row.Currency]
      );
      // The row holds the price the sale was made at, which is the policy's
      // current price - or, when the price was corrected later, the amount of
      // its first "Edit <blanc>" reversal.
      const list = (candidates || []).filter(
        (c) =>
          money(c.Price) === money(row.Amount) ||
          money(c.EditedFrom) === money(row.Amount)
      );
      if (list.length === 0) {
        reason = "no policy created at that second with that amount";
      } else if (list.length > 1) {
        reason = `${list.length} policies match - too ambiguous`;
      } else {
        const policy = list[0];
        // The policy must not already OWN a sale row written at its creation.
        // A row written later under its blanc is a price-change re-booking
        // ("Edit <blanc>" + the new price), which presupposes this sale row.
        const [own] = await conn.query(
          `SELECT COUNT(*) AS n FROM cash_transactions
            WHERE Reason = ? AND Branch = ? AND Type = 'increase'
              AND CreatedAt = ?`,
          [
            String(policy.BlancNumber),
            row.Branch,
            String(policy.CreatedAt ?? ""),
          ]
        );
        if (Number(own[0] && own[0].n)) {
          reason = "that policy already has a sale row under its own blanc";
        } else {
          target = {
            BlancNumber: String(policy.BlancNumber),
            PolicyNumber: String(policy.PolicyNumber ?? ""),
            Deleted: Number(policy.Deleted) || 0,
          };
        }
      }
    }

    out.push({ row, target, reason });
  }
  return out;
}

const describeRow = (row) =>
  `#${row.id} ${row.CreatedAt} ${money(row.Amount)} ${row.Currency} ` +
  `${row.Type} "${row.Reason}" by ${row.Username} @ ${row.Branch}`;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const target = databaseSettings(args);

  console.log(
    `${target.live ? "LIVE" : "local"} database: ` +
      `${target.user}@${target.host}:${target.port}/${target.database}`
  );

  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    dateStrings: true,
  });

  const found = await findStrandedSales(conn);
  const fixes = found.filter((f) => f.target);
  const review = found.filter((f) => !f.target);

  for (const { row, target: fix, reason } of found) {
    if (fix) {
      console.log(
        `FIX    ${describeRow(row)}\n       -> "${fix.BlancNumber}" ` +
          `(policy ${fix.PolicyNumber || "-"}${fix.Deleted ? ", deleted" : ""})`
      );
    } else {
      console.log(`REVIEW ${describeRow(row)}\n       ${reason}`);
    }
  }

  if (apply && fixes.length) {
    await conn.beginTransaction();
    try {
      for (const { row, target: fix } of fixes) {
        const [cash] = await conn.query(
          "UPDATE cash_transactions SET Reason = ? WHERE id = ?",
          [fix.BlancNumber, row.id]
        );
        // The mirror row in Total cash carries the same reason and money.
        const [total] = await conn.query(
          `UPDATE total_cash_transactions
              SET Reason = ?
            WHERE Reason = ? AND Branch = ? AND Amount = ?
              AND Username = ? AND CreatedAt = ? AND Type = ?`,
          [
            fix.BlancNumber,
            row.Reason,
            row.Branch,
            row.Amount,
            row.Username,
            row.CreatedAt,
            row.Type,
          ]
        );
        console.log(
          `  wrote #${row.id} -> ${fix.BlancNumber} ` +
            `(cash ${cash.affectedRows || 0}, total ${total.affectedRows || 0})`
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  console.log(
    `\nSummary: ${fixes.length} relabel(s), ${review.length} row(s) for review` +
      `${apply ? " - written" : " found (nothing written - run with --apply)"}. ` +
      "current_cash and the policies are not touched."
  );

  await conn.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Drawer ledger patch failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { findStrandedSales };

"use strict";
// Fold old broker "price_change" rows into the policy's one SALE row.
//
// Run from the repo root:
//   node --env-file=.env db/fold-broker-price-changes.js          (report only)
//   node --env-file=.env db/fold-broker-price-changes.js --apply  (write fixes)
//   node --env-file=.env db/fold-broker-price-changes.js --live   (LIVE_DB_*)
//   ... --broker=25                                               (one broker)
//
// The server no longer writes a "price_change" row when an insurance's price is
// corrected: the delta is folded into the policy's sale row (Type = "policy"),
// whose CreatedAt is the policy's creation day. Rows written by older servers
// still sit in the ledger. This script folds them the same way:
//
//   sale.Amount += SUM(live price_change.Amount)
//   DELETE the folded price_change rows
//
// The sale row keeps its own CreatedAt, so the corrected price belongs to the
// day the policy was created - not to the day it was edited. For a LIVE sale
// row the sum of the history is unchanged, so no broker balance moves.
//
// A SOFT-DELETED sale row is a VOID ("do not charge the broker for this
// policy"): its amount is folded too, so it goes on cancelling the policy at
// its current price. Where that changes the void, a balance REBUILT from the
// insurances (brokers with a starting balance) picks the difference up on its
// next recalculation; the stored figure is not written here.
//
// It is safe to run more than once: after the first --apply there is nothing
// left to fold. Soft-deleted (void) PRICE_CHANGE rows are NOT touched - a void
// is a deliberate "do not charge" and folding it would undo that decision.
// A policy with no sale row at all is reported, not guessed at.

const mysql = require("mysql2/promise");

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const key = (value) => String(value ?? "").trim();

function databaseSettings(args) {
  const live = args.includes("--live");
  const prefix = live ? "LIVE_DB_" : "DB_";
  const password = process.env[`${prefix}PASSWORD`];
  if (!password) throw new Error(`Missing ${prefix}PASSWORD in .env`);
  return {
    live,
    host: process.env[`${prefix}HOST`] || "localhost",
    port: Number(process.env[`${prefix}PORT`] || 5500),
    user: process.env[`${prefix}USER`] || "root",
    password,
    database: process.env[`${prefix}NAME`] || "insurancedb",
  };
}

async function findSaleRow(conn, brokerId, blanc, saleMovementId) {
  if (saleMovementId) {
    const [[linked]] = await conn.query(
      `SELECT id, Amount, CreatedAt, Deleted
         FROM broker_balance_movements
        WHERE id = ? AND BrokerId = ? AND Type = 'policy'`,
      [saleMovementId, brokerId]
    );
    if (linked) return linked;
  }
  const [[oldest]] = await conn.query(
    `SELECT id, Amount, CreatedAt, Deleted
       FROM broker_balance_movements
      WHERE BrokerId = ? AND BlancNumber = ? AND Type = 'policy'
      ORDER BY id ASC LIMIT 1`,
    [brokerId, blanc]
  );
  return oldest || null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const brokerArg = args.map((a) => /^--broker=(\d+)$/.exec(a)).find(Boolean);
  const onlyBrokerId = brokerArg ? Number(brokerArg[1]) : null;
  const target = databaseSettings(args);

  console.log(
    `${target.live ? "LIVE" : "local"} database: ` +
      `${target.user}@${target.host}:${target.port}/${target.database}`
  );
  console.log(apply ? "MODE: apply (rows will be folded)" : "MODE: report only");

  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    dateStrings: true,
  });

  // Live (not voided) price corrections that still name a policy.
  const [rows] = await conn.query(
    `SELECT m.id, m.BrokerId, m.Amount, m.BlancNumber
       FROM broker_balance_movements m
      WHERE m.Type = 'price_change' AND m.Deleted = 0
        AND m.BlancNumber IS NOT NULL AND m.BlancNumber <> ''
        ${onlyBrokerId !== null ? "AND m.BrokerId = ?" : ""}
      ORDER BY m.BrokerId, m.BlancNumber, m.id`,
    onlyBrokerId !== null ? [onlyBrokerId] : []
  );

  const groups = new Map();
  for (const row of rows) {
    const k = `${row.BrokerId}\u0000${key(row.BlancNumber)}`;
    if (!groups.has(k)) {
      groups.set(k, {
        brokerId: Number(row.BrokerId),
        blanc: key(row.BlancNumber),
        ids: [],
        sum: 0,
      });
    }
    const g = groups.get(k);
    g.ids.push(row.id);
    g.sum = r2(g.sum + (Number(row.Amount) || 0));
  }

  let folded = 0;
  let deleted = 0;
  const unresolved = [];
  const brokerNames = new Map();

  for (const g of groups.values()) {
    if (!brokerNames.has(g.brokerId)) {
      const [[b]] = await conn.query(
        "SELECT Name FROM brokers WHERE id = ?",
        [g.brokerId]
      );
      brokerNames.set(g.brokerId, b ? b.Name : `#${g.brokerId}`);
    }
    const name = brokerNames.get(g.brokerId);

    const [[policy]] = await conn.query(
      `SELECT CreationDate, Price, SaleMovementId
         FROM insurance WHERE BlancNumber = ? AND BrokerId = ? LIMIT 1`,
      [g.blanc, g.brokerId]
    );
    const sale = await findSaleRow(
      conn,
      g.brokerId,
      g.blanc,
      policy ? policy.SaleMovementId : null
    );

    if (!sale) {
      unresolved.push(
        `${name} / ${g.blanc}: ${g.ids.length} price row(s), no sale row ` +
          `(moved-away policy or missing history) - review by hand`
      );
      continue;
    }

    const next = r2(Number(sale.Amount) + g.sum);
    console.log(
      `${apply ? "FOLD" : "would fold"} ${name} / ${g.blanc}: ` +
        `sale #${sale.id} ${r2(sale.Amount)} -> ${next} ` +
        `(${g.ids.length} row(s), ${g.sum >= 0 ? "+" : ""}${g.sum})` +
        `${sale.Deleted ? " [sale is a void]" : ""}`
    );

    if (!apply) {
      folded++;
      deleted += g.ids.length;
      continue;
    }

    await conn.beginTransaction();
    try {
      await conn.query(
        "UPDATE broker_balance_movements SET Amount = ? WHERE id = ?",
        [next, sale.id]
      );
      await conn.query(
        `DELETE FROM broker_balance_movements WHERE id IN (${g.ids
          .map(() => "?")
          .join(", ")})`,
        g.ids
      );
      await conn.commit();
      folded++;
      deleted += g.ids.length;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  console.log("");
  console.log(
    `${apply ? "Folded" : "Would fold"} ${folded} sale row(s); ` +
      `${apply ? "deleted" : "would delete"} ${deleted} price row(s).`
  );
  if (unresolved.length) {
    console.log("");
    console.log("Needs review:");
    for (const line of unresolved) console.log("  - " + line);
  }
  if (!apply && folded > 0) {
    console.log("");
    console.log("Re-run with --apply to write the changes.");
  }

  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


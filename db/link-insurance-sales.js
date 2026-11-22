"use strict";
// Link every broker policy to the history row of its sale (`insurance.
// SaleMovementId`) - the structural fix for "the charge is missing from the
// balance history even though the insurance exists".
//
// Run from the repo root:
//   node --env-file=.env db/link-insurance-sales.js           (report only)
//   node --env-file=.env db/link-insurance-sales.js --apply   (add the column,
//                                                              backfill links)
//   node --env-file=.env db/link-insurance-sales.js --live            (report)
//   node --env-file=.env db/link-insurance-sales.js --live --apply    (fix live)
//
// Why: the balance history pairs a `broker_balance_movements` row with a policy
// by BlancNumber. A policy's charge row keeps the number it was written with, so
// a blanc correction made by an older server left the sale attached to a number
// no policy carries any more - and the history page hides such a row. The link
// makes the pairing independent of the number:
//
//   insurance.SaleMovementId -> broker_balance_movements.id of the SALE row
//   UNIQUE KEY unique_insurance_sale_movement (SaleMovementId)
//
// The server writes the link on every sale (create, restore, broker move) and
// the history endpoint reads it, so a blanc edit can never detach the charge
// again. This script adds the column where it is missing and fills the link for
// policies sold before the server did that.
//
// A policy is linked to the live `policy` row of the same broker and blanc whose
// CreatedAt equals the policy's CreationDate (the server copies it on sale).
// Only an unambiguous pair is linked (exactly one candidate). A policy whose
// sale row is missing or sits under an older blanc is not guessed: run
// db/repair-broker-ledger.js first (or migrations/fix_broker_history_gaps.sql),
// then this script again. Idempotent - a second run changes nothing.

const mysql = require("mysql2/promise");

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasIndex(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return rows.length > 0;
}

/**
 * Fill insurance.SaleMovementId for every policy that has none.
 *
 * The sale row is the OLDEST live `policy` movement of the same broker and
 * blanc (row ids grow with time, and a restore writes a newer one). It is the
 * row the history page already shows for the policy, so linking it never moves
 * money and never changes what is shown - it only makes the pairing independent
 * of the blanc, so a later blanc correction cannot detach it. A policy with no
 * live sale row (a void, a missing row or a row left under an older blanc) is
 * left NULL: `db/repair-broker-ledger.js` (or the SQL in Insurance/migrations)
 * has to put that row right first.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @returns {Promise<number>} policies linked
 */
async function backfillSaleLinks(conn) {
  const [result] = await conn.query(
    `UPDATE insurance i
       JOIN (
             SELECT i2.BlancNumber, MIN(m.id) AS MovementId
               FROM insurance i2
               JOIN broker_balance_movements m
                 ON m.BrokerId = i2.BrokerId
                AND m.BlancNumber = i2.BlancNumber
                AND m.Type = 'policy'
                AND m.Deleted = 0
              WHERE i2.BrokerId IS NOT NULL AND i2.SaleMovementId IS NULL
              GROUP BY i2.BlancNumber
            ) sale ON sale.BlancNumber = i.BlancNumber
        SET i.SaleMovementId = sale.MovementId
      WHERE i.SaleMovementId IS NULL`
  );
  return Number(result && result.affectedRows) || 0;
}

/** Add the link column and its unique key where they are missing. */
async function ensureLinkColumn(conn) {
  if (!(await hasColumn(conn, "insurance", "SaleMovementId"))) {
    await conn.query(
      "ALTER TABLE insurance ADD COLUMN SaleMovementId INT NULL AFTER DeletedBy"
    );
    console.log("Added insurance.SaleMovementId column");
  }
  if (!(await hasIndex(conn, "insurance", "unique_insurance_sale_movement"))) {
    await conn.query(
      "ALTER TABLE insurance ADD UNIQUE KEY unique_insurance_sale_movement (SaleMovementId)"
    );
    console.log("Added unique_insurance_sale_movement key");
  }
}

function settings(args) {
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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const target = settings(args);
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

  const columnExists = await hasColumn(conn, "insurance", "SaleMovementId");
  if (!columnExists) {
    console.log("insurance.SaleMovementId: MISSING");
    if (!apply) {
      console.log("Run again with --apply to add it and link the policies.");
      await conn.end();
      return;
    }
  }
  if (apply) await ensureLinkColumn(conn);

  const [[counts]] = await conn.query(
    `SELECT COUNT(*) AS LiveBrokerPolicies,
            SUM(SaleMovementId IS NOT NULL) AS Linked,
            SUM(SaleMovementId IS NULL) AS NotLinked
       FROM insurance
      WHERE Deleted = 0 AND BrokerId IS NOT NULL`
  );
  console.log(
    `live broker policies: ${counts.LiveBrokerPolicies}, ` +
      `linked: ${counts.Linked}, not linked: ${counts.NotLinked}`
  );

  if (apply) {
    const linked = await backfillSaleLinks(conn);
    console.log(`Linked ${linked} policy(ies) to their sale row.`);
    const [[after]] = await conn.query(
      `SELECT SUM(SaleMovementId IS NOT NULL) AS Linked,
              SUM(SaleMovementId IS NULL) AS NotLinked
         FROM insurance
        WHERE Deleted = 0 AND BrokerId IS NOT NULL`
    );
    console.log(
      `now linked: ${after.Linked}, still not linked: ${after.NotLinked}`
    );
  }

  // What is still unlinked, per broker: usually a sale row that a repair has to
  // re-attach first (db/repair-broker-ledger.js).
  const [pending] = await conn.query(
    `SELECT i.BrokerId, b.Name AS Broker, COUNT(*) AS Unlinked
       FROM insurance i
       LEFT JOIN brokers b ON b.id = i.BrokerId
      WHERE i.Deleted = 0 AND i.BrokerId IS NOT NULL
        AND i.SaleMovementId IS NULL
      GROUP BY i.BrokerId, b.Name
      ORDER BY Unlinked DESC, i.BrokerId`
  );
  if (pending.length > 0) {
    console.log("\nunlinked policies per broker:");
    for (const row of pending) {
      console.log(
        `  broker ${row.BrokerId} (${row.Broker || "?"}): ${row.Unlinked}`
      );
    }
  } else {
    console.log("\nevery live broker policy is linked to its sale row.");
  }

  await conn.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Linking failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { backfillSaleLinks, ensureLinkColumn };


"use strict";
// One-off upgrades for a database created before the server made the change
// itself.
//
// Run from the repo root:
//   node --env-file=.env db/legacy-upgrades.js --tariffs            (report)
//   node --env-file=.env db/legacy-upgrades.js --tariffs --apply
//   node --env-file=.env db/legacy-upgrades.js --swap               (report)
//   node --env-file=.env db/legacy-upgrades.js --swap --apply
//   node --env-file=.env db/legacy-upgrades.js --shift-times        (report)
//   node --env-file=.env db/legacy-upgrades.js --shift-times --apply --hours=3
//   add --live to target LIVE_DB_* (same as db/repair-broker-ledger.js)
//
// Why it exists: three changes reached the live database before the server knew
// how to make them. Their SQL used to live in the client repository
// (Insurance/migrations); the server repository owns every schema and data
// change now, so the runbooks are here.
//
//   1. raiseTurkishLiraTariffs - the Turkish-lira walk-in Auto prices raised to
//      1 600 / 2 050 / 2 300 TRY for 15 / 30 / 90 days on 2026-11-24.
//      `db/setup.js` runs it on an explicit setup: it only raises the three
//      known OLD values, so an admin's later price is never reverted, a
//      database that seeds its tariffs from BrokerInfo.js already has the new
//      prices, and a plain server restart touches nothing.
//
//   2. swapMisplacedNumbers - policies stored with the 8-character
//      PolicyNumber and the 6-character BlancNumber in each other's columns,
//      plus the current-cash and total-cash ledger rows that point at the
//      policy by its blanc. Needs --apply: it swaps a PRIMARY KEY, which is a
//      decision, not a repair.
//
//   3. shiftLegacyTimestamps - rows stamped by MySQL (NOW() /
//      CURRENT_TIMESTAMP) while the database ran in UTC, three hours behind the
//      workers' local time (Bulgaria, UTC+3 in summer). Needs --apply, and it
//      refuses to run twice: the backup tables the first run writes are the
//      guard. Never run it on a database whose rows are already local - local
//      and UTC rows cannot be told apart after the fact.
//
// Nothing else here runs on a server start: only the tariff raise is part of
// `db/setup.js`, and that file runs its data steps on an explicit setup only.

const mysql = require("mysql2/promise");
const { databaseSettings } = require("./repair-broker-ledger.js");

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * The Turkish-lira Auto tariff of Lesovo and Kapitan Andreevo: the value the
 * live rows carried until 2026-11-24 and the value they were raised to. A
 * duration whose old and new price are equal (15 days) is listed anyway, so the
 * table reads like the price list; `nextTryPrice` skips it.
 */
const TRY_AUTO_PRICES = {
  15: { from: 1600, to: 1600 },
  30: { from: 2000, to: 2050 },
  90: { from: 2200, to: 2300 },
};

/**
 * The price a database row should be raised to, or null when it needs nothing.
 *
 * Only the known OLD price is raised: a row an admin priced differently is left
 * alone, so this can never undo a later price change.
 *
 * @param {number|string} duration 15, 30 or 90 days
 * @param {number|string} price the stored price
 * @returns {number|null}
 */
function nextTryPrice(duration, price) {
  const step = TRY_AUTO_PRICES[Number(duration)];
  if (!step) return null;
  if (Math.abs(r2(price) - step.from) > 0.005) return null;
  return step.to === step.from ? null : step.to;
}

/**
 * Raise the old Turkish-lira Auto walk-in prices.
 *
 * Without `apply` it only reports the rows it would raise. Idempotent: after
 * the first write no row carries an old price any more.
 *
 * @param {{query: Function}} db
 * @param {{apply?: boolean, log?: Function}} [options]
 * @returns {Promise<Array<{id:number, Branch:string, Duration:number,
 *          from:number, to:number}>>} the rows that were (or would be) raised
 */
async function raiseTurkishLiraTariffs(db, { apply = false, log = () => {} } = {}) {
  const [rows] = await db.query(
    `SELECT id, Branch, Duration, Price
       FROM branch_tariffs
      WHERE Currency = 'TRY' AND InsuranceType = 'Auto'
        AND Duration IN (15, 30, 90)`
  );
  const raised = [];
  for (const row of rows || []) {
    const price = nextTryPrice(row.Duration, row.Price);
    if (price === null) continue;
    if (apply) {
      await db.query("UPDATE branch_tariffs SET Price = ? WHERE id = ?", [
        price,
        row.id,
      ]);
    }
    raised.push({
      id: row.id,
      Branch: row.Branch,
      Duration: Number(row.Duration),
      from: r2(row.Price),
      to: price,
    });
  }
  if (raised.length) {
    log(
      `${apply ? "Raised" : "Would raise"} ${raised.length} Turkish-lira ` +
        `Auto tariff(s): ` +
        raised
          .map((r) => `${r.Branch} ${r.Duration}d ${r.from} -> ${r.to}`)
          .join(", ")
    );
  }
  return raised;
}


// A policy number is exactly 8 characters and a blanc number exactly 6.
const POLICY_NUMBER_LENGTH = 8;
const BLANC_NUMBER_LENGTH = 6;

/**
 * Split the rows that carry both numbers the wrong way round into the ones that
 * can be swapped and the ones that cannot (the blanc the policy would take is
 * already in use, so swapping would break the primary key).
 *
 * A row is only a candidate when PolicyNumber is exactly 6 characters and
 * BlancNumber exactly 8. Anything else (empty, a different length) is left for
 * a human, exactly like the original migration.
 *
 * @param {Array<{BlancNumber: string, PolicyNumber: string}>} rows
 * @param {Set<string>} allBlancs every blanc number currently in the table
 * @returns {{swaps: Array<{from:string, to:string}>,
 *            collisions: Array<{from:string, to:string}>}}
 */
function classifyNumberSwap(rows, allBlancs) {
  const swaps = [];
  const collisions = [];
  for (const row of rows || []) {
    const oldBlanc = String(row.BlancNumber ?? "");
    const oldPolicy = String(row.PolicyNumber ?? "");
    if (oldBlanc.length !== POLICY_NUMBER_LENGTH) continue;
    if (oldPolicy.length !== BLANC_NUMBER_LENGTH) continue;
    // `from` is the blanc the row carries now, `to` the 6-character number that
    // belongs in that column (the value stored as the policy number).
    const entry = { from: oldBlanc, to: oldPolicy };
    if (allBlancs && allBlancs.has(oldPolicy)) collisions.push(entry);
    else swaps.push(entry);
  }
  return { swaps, collisions };
}

/**
 * The ledger reasons that point at a policy by its blanc (see
 * Requests/CurrentCash.js and Requests/TotalCash.js).
 *
 * @param {string} blanc
 * @returns {string[]}
 */
function reasonsForBlanc(blanc) {
  return [blanc, `Edit ${blanc}`, `Annul ${blanc}`];
}

/**
 * Swap the policy/blanc numbers stored in each other's columns and point the
 * cash ledgers at the corrected blanc.
 *
 * Nothing is written without `apply`, and never when a swap would collide with
 * a blanc number already in use.
 *
 * @param {{query: Function, beginTransaction: Function, commit: Function,
 *          rollback: Function}} db
 * @param {{apply?: boolean, log?: Function}} [options]
 * @returns {Promise<{swaps: Array, collisions: Array, applied: boolean,
 *          cashRows: number, totalCashRows: number}>}
 */
async function swapMisplacedNumbers(db, { apply = false, log = () => {} } = {}) {
  const [rows] = await db.query(
    `SELECT BlancNumber, PolicyNumber
       FROM insurance
      WHERE CHAR_LENGTH(PolicyNumber) = ? AND CHAR_LENGTH(BlancNumber) = ?`,
    [BLANC_NUMBER_LENGTH, POLICY_NUMBER_LENGTH]
  );
  const empty = {
    swaps: [],
    collisions: [],
    applied: false,
    cashRows: 0,
    totalCashRows: 0,
  };
  if (!rows || rows.length === 0) return empty;

  const [blancRows] = await db.query("SELECT BlancNumber FROM insurance");
  const allBlancs = new Set((blancRows || []).map((r) => String(r.BlancNumber)));
  const { swaps, collisions } = classifyNumberSwap(rows, allBlancs);

  if (!apply || collisions.length > 0) {
    return { ...empty, swaps, collisions };
  }

  // Keep the original values, like the original migration did, so the swap can
  // be undone. `IF NOT EXISTS` keeps a second run (or a database where the old
  // SQL already wrote this table) from failing.
  await db.query(`
    CREATE TABLE IF NOT EXISTS insurance_number_swap_backup (
      OldBlancNumber VARCHAR(45) NOT NULL,
      OldPolicyNumber VARCHAR(45) NOT NULL,
      BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (OldBlancNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    COMMENT='PolicyNumber/BlancNumber before a swap performed by db/legacy-upgrades.js'
  `);

  let cashRows = 0;
  let totalCashRows = 0;
  await db.beginTransaction();
  try {
    for (const swap of swaps) {
      await db.query(
        `INSERT IGNORE INTO insurance_number_swap_backup
           (OldBlancNumber, OldPolicyNumber)
         VALUES (?, ?)`,
        [swap.from, swap.to]
      );
      // Read the originals from the backup: MySQL applies `SET a = b, b = a`
      // left to right, so the second assignment would already see the new value.
      await db.query(
        `UPDATE insurance i
           JOIN insurance_number_swap_backup b ON b.OldBlancNumber = i.BlancNumber
            SET i.BlancNumber = b.OldPolicyNumber,
                i.PolicyNumber = b.OldBlancNumber`
      );
      // The ledgers point at the blanc the policy carried BEFORE the swap;
      // after it, the policy (and so its money) sits under the 6-digit number.
      const oldReasons = reasonsForBlanc(swap.from);
      const newReasons = reasonsForBlanc(swap.to);
      for (let i = 0; i < oldReasons.length; i += 1) {
        const [cash] = await db.query(
          "UPDATE cash_transactions SET Reason = ? WHERE Reason = ?",
          [newReasons[i], oldReasons[i]]
        );
        const [totalCash] = await db.query(
          "UPDATE total_cash_transactions SET Reason = ? WHERE Reason = ?",
          [newReasons[i], oldReasons[i]]
        );
        cashRows += Number(cash && cash.affectedRows) || 0;
        totalCashRows += Number(totalCash && totalCash.affectedRows) || 0;
      }
    }
    await db.commit();
  } catch (err) {
    await db.rollback();
    throw err;
  }

  log(
    `Swapped the policy and blanc number of ${swaps.length} insurance(s); ` +
      `relabelled ${cashRows} drawer row(s) and ${totalCashRows} total-cash row(s).`
  );
  return { swaps, collisions, applied: true, cashRows, totalCashRows };
}

/**
 * Does a table exist in the connected database? Used as the marker of a
 * timestamp shift that already ran: the first run writes its backup table.
 *
 * @param {{query: Function}} db
 * @param {string} table
 * @returns {Promise<boolean>}
 */
async function tableExists(db, table) {
  const [rows] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return Array.isArray(rows) && rows.length > 0;
}

// The cash ledgers that carry a CreatedAt stamped by the database.
const CASH_LEDGER_TABLES = [
  "cash_transactions",
  "cash_resets",
  "card_resets",
  "total_cash_transactions",
];

/**
 * Accept only a whole number of hours a shifted row can be off by.
 *
 * @param {number|string} value
 * @returns {number}
 */
function normalizeHours(value) {
  const hours = Math.trunc(Number(value));
  if (!Number.isFinite(hours) || hours === 0 || Math.abs(hours) > 23) {
    throw new Error(
      `--hours must be a whole number between -23 and 23 (got ${value})`
    );
  }
  return hours;
}

/**
 * Shift the rows stamped while the database ran in UTC to local time.
 *
 * Two independent parts, each with its own backup table as the "already
 * applied" guard:
 *   - `insurance.CreationDate`    -> insurance_creationdate_backup
 *   - the cash ledgers' CreatedAt -> cash_createdate_backup
 *
 * Without `apply` it only reports what it would shift.
 *
 * @param {{query: Function}} db
 * @param {{apply?: boolean, hours?: number|string, log?: Function}} [options]
 * @returns {Promise<{hours:number, applied:boolean, parts:Array<object>}>}
 */
async function shiftLegacyTimestamps(
  db,
  { apply = false, hours = 3, log = () => {} } = {}
) {
  const shift = normalizeHours(hours);
  const result = { hours: shift, applied: false, parts: [] };

  // 1) insurance.CreationDate
  if (await tableExists(db, "insurance_creationdate_backup")) {
    result.parts.push({
      part: "insurance",
      status: "already applied (insurance_creationdate_backup exists)",
    });
  } else {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM insurance");
    if (!apply) {
      result.parts.push({
        part: "insurance",
        status: "pending",
        rows: Number(n),
      });
    } else {
      await db.query(`
        CREATE TABLE insurance_creationdate_backup (
          BlancNumber VARCHAR(45) NOT NULL,
          CreationDate DATETIME NOT NULL,
          BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (BlancNumber)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COMMENT='CreationDate before db/legacy-upgrades.js shifted it to local time'
      `);
      await db.query(
        `INSERT INTO insurance_creationdate_backup (BlancNumber, CreationDate)
         SELECT BlancNumber, CreationDate FROM insurance`
      );
      const [shifted] = await db.query(
        `UPDATE insurance SET CreationDate = CreationDate + INTERVAL ${shift} HOUR`
      );
      result.parts.push({
        part: "insurance",
        status: "shifted",
        rows: Number(shifted && shifted.affectedRows) || 0,
      });
    }
  }

  // 2) The cash ledgers.
  if (await tableExists(db, "cash_createdate_backup")) {
    result.parts.push({
      part: "cash ledgers",
      status: "already applied (cash_createdate_backup exists)",
    });
  } else {
    const counts = {};
    for (const table of CASH_LEDGER_TABLES) {
      const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = Number(n);
    }
    if (!apply) {
      result.parts.push({
        part: "cash ledgers",
        status: "pending",
        rows: counts,
      });
    } else {
      await db.query(`
        CREATE TABLE cash_createdate_backup (
          TableName VARCHAR(64) NOT NULL,
          id INT NOT NULL,
          CreatedAt DATETIME NOT NULL,
          BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (TableName, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COMMENT='CreatedAt of the cash ledgers before db/legacy-upgrades.js flagged them local'
      `);
      for (const table of CASH_LEDGER_TABLES) {
        await db.query(
          `INSERT INTO cash_createdate_backup (TableName, id, CreatedAt)
           SELECT ?, id, CreatedAt FROM ${table}`,
          [table]
        );
        await db.query(
          `UPDATE ${table} SET CreatedAt = CreatedAt + INTERVAL ${shift} HOUR`
        );
      }
      result.parts.push({ part: "cash ledgers", status: "shifted", rows: counts });
    }
  }

  result.applied = apply && result.parts.every((p) => p.status === "shifted");
  for (const part of result.parts) {
    if (part.status === "pending") {
      log(
        `${part.part}: ${JSON.stringify(part.rows)} row(s) to shift by ${shift}h`
      );
    } else if (part.status === "shifted") {
      log(
        `${part.part}: shifted by ${shift}h (` +
          (typeof part.rows === "number"
            ? `${part.rows} row(s)`
            : JSON.stringify(part.rows)) +
          ")"
      );
    } else {
      log(`${part.part}: ${part.status}`);
    }
  }
  return result;
}

/** `--name=value` or `--name value`. */
function argValue(args, name) {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const tariffs = args.includes("--tariffs");
  const swap = args.includes("--swap");
  const shiftTimes = args.includes("--shift-times");
  if (!tariffs && !swap && !shiftTimes) {
    throw new Error(
      "Pass what to run: --tariffs, --swap or --shift-times (add --apply to write)"
    );
  }

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

  try {
    if (tariffs) {
      const raised = await raiseTurkishLiraTariffs(conn, {
        apply,
        log: console.log,
      });
      if (!raised.length) {
        console.log("Turkish-lira Auto tariffs: nothing to raise.");
      } else if (!apply) {
        console.log("Nothing written - rerun with --apply to raise the prices.");
      }
    }

    if (swap) {
      const result = await swapMisplacedNumbers(conn, {
        apply,
        log: console.log,
      });
      if (result.swaps.length === 0 && result.collisions.length === 0) {
        console.log("No policy/blanc numbers are stored the wrong way round.");
      }
      for (const swapRow of result.swaps) {
        console.log(
          `  ${swapRow.from} -> ${swapRow.to}` +
            (apply ? "" : "   (nothing written - rerun with --apply)")
        );
      }
      for (const collision of result.collisions) {
        console.log(
          `  ${collision.from} -> ${collision.to}   COLLISION: ` +
            `blanc ${collision.to} is already in use - fix it by hand`
        );
      }
    }

    if (shiftTimes) {
      const result = await shiftLegacyTimestamps(conn, {
        apply,
        hours: argValue(args, "hours") || 3,
        log: console.log,
      });
      if (!apply) {
        console.log("Nothing written - rerun with --apply to shift the rows.");
      } else if (!result.applied) {
        console.log("Nothing to shift.");
      }
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Legacy upgrade failed:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = {
  TRY_AUTO_PRICES,
  nextTryPrice,
  raiseTurkishLiraTariffs,
  classifyNumberSwap,
  swapMisplacedNumbers,
  shiftLegacyTimestamps,
  normalizeHours,
  tableExists,
  CASH_LEDGER_TABLES,
  reasonsForBlanc,
};

"use strict";
// Read-only check of one broker's policies for a date range: how many policies
// per duration and vehicle type, what they add up to, what the annulled ones
// contribute, and the same again grouped by price and vehicle type (the way a
// broker's price list reads: 169 x 19 EUR, 648 x 31 EUR, ...).
//
// Run from the repo root:
//   node --env-file=.env db/check-broker-period.js --broker=19 --from=2026-10-10 --to=2026-11-25
//   node --env-file=.env db/check-broker-period.js --broker=19 --from=... --to=... --live
//
// Why: a broker sends a period statement (for instance "169 x 15D, 22 x 1M
// automobile, ..., 17 annulled, 24 005 EUR") and the figures have to be checked
// against the database. Counting by hand mixes up the two things a period can
// be asked for:
//
//   * "without annulled" - the live policies at their Price (an annulled policy
//     has already been refunded and its stored Price is the annulment fee only,
//     so it is left out);
//   * "including annulled" - the same plus the annulment fees. The bill
//     (db/brokerBills.js) charges every annulment fee, while the broker BALANCE
//     only charges the ones the broker is at fault for (AnnulReason =
//     'broker'), so both totals are printed.
//
// The period is [--from, --to] inclusive, filtered by CreationDate - the same
// window a bill uses (a policy created on a cutoff day belongs to the NEXT
// period, see Requests/PaymentSchedule.js). Soft-deleted policies are never
// counted (a bill leaves them off), but they are listed so a statement that
// still carries one can be recognised.
//
// A statement also carries money that no policy explains (a medical insurance
// recorded with the retired "Reduce" button, say). Those ledger rows are listed
// too, with the total they make of the policies: that is how a statement like
// "169 x 15D ... 24 005 EUR" is checked line by line.
//
// Nothing is written: the script only reads `insurance`, `brokers`,
// `broker_tariffs` and `broker_balance_movements`. It is safe against the live
// database.

const mysql = require("mysql2/promise");
const { databaseSettings } = require("./repair-broker-ledger.js");
const { isSubBrokerName } = require("./BrokerInfo.js");
const { periodFor, periodStartFor, shiftDays } = require("../Requests/PaymentSchedule.js");
const bills = require("./brokerBills.js");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "15D" / "1M" / "3M" - the shorthand the broker statements use (15/30/90 days).
function durationLabel(days) {
  const n = Number(days) || 0;
  if (n === 15) return "15D";
  if (n === 30) return "1M";
  if (n === 90) return "3M";
  return `${n}D`;
}

const money = (value) => round2(value).toFixed(2).padStart(10, " ");

/**
 * The period of one broker, split the way a statement is: per duration and
 * vehicle type, the live policies and the annulled ones.
 *
 * The money follows db/brokerBills.js: a policy counts with its Price, an
 * annulled one with its AnnulFee, and a charge an admin hid on the broker's
 * balance history (a void) is left out.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {string} periodStart "YYYY-MM-DD" (inclusive)
 * @param {string} periodEnd   "YYYY-MM-DD" (inclusive)
 * @returns {Promise<object>}
 */
async function loadPeriodFigures(conn, brokerId, periodStart, periodEnd) {
  const rows = await bills.loadBillLines(conn, brokerId, periodStart, periodEnd);
  const voids = await bills.loadVoidedCharges(
    conn,
    brokerId,
    periodStart,
    periodEnd
  );

  const lines = [];
  const voidedLines = [];
  for (const row of rows) {
    const base = bills.toBillLine(row);
    const voided = voids.byBlanc.get(base.blancNumber) || 0;
    const payer = String(row.AnnulReason ?? "").trim() || "none";
    const entry = { ...base, annulReason: payer };
    if (voided === 0) {
      lines.push(entry);
      continue;
    }
    // A hidden sale row voids the whole charge: the policy is not billed at
    // all. Otherwise the void is a delta the admin removed from the charge.
    if (round2(base.amount + voided) === 0) {
      voidedLines.push({ ...entry, voided });
      continue;
    }
    lines.push({ ...entry, amount: round2(base.amount + voided), voided });
  }

  const buckets = new Map();
  const priceBuckets = new Map();
  const feesByPayer = { broker: 0, worker: 0, none: 0 };
  let activeCount = 0;
  let activeMoney = 0;
  let annulledCount = 0;
  let annulledFees = 0;

  for (const line of lines) {
    const type = line.type || "(no type)";
    const key = `${durationLabel(line.duration)} ${type}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        activeCount: 0,
        activeMoney: 0,
        annulledCount: 0,
        annulledFees: 0,
      });
    }
    const bucket = buckets.get(key);

    // The same money seen the way the broker's own price list shows it: by
    // vehicle type and price (an annulled policy sits at its annulment fee).
    const price = round2(line.amount);
    const priceKey = `${type}|${price.toFixed(2)}`;
    if (!priceBuckets.has(priceKey)) {
      priceBuckets.set(priceKey, {
        type,
        price,
        activeCount: 0,
        activeMoney: 0,
        annulledCount: 0,
        annulledFees: 0,
        total: 0,
      });
    }
    const priceBucket = priceBuckets.get(priceKey);

    if (line.annulled) {
      const payer = line.annulReason in feesByPayer ? line.annulReason : "none";
      annulledCount += 1;
      annulledFees = round2(annulledFees + line.amount);
      feesByPayer[payer] = round2(feesByPayer[payer] + line.amount);
      bucket.annulledCount += 1;
      bucket.annulledFees = round2(bucket.annulledFees + line.amount);
      priceBucket.annulledCount += 1;
      priceBucket.annulledFees = round2(priceBucket.annulledFees + line.amount);
    } else {
      activeCount += 1;
      activeMoney = round2(activeMoney + line.amount);
      bucket.activeCount += 1;
      bucket.activeMoney = round2(bucket.activeMoney + line.amount);
      priceBucket.activeCount += 1;
      priceBucket.activeMoney = round2(priceBucket.activeMoney + line.amount);
    }
  }

  const bucketsSorted = [...buckets.values()].sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const priceBucketsSorted = [...priceBuckets.values()]
    .map((bucket) => ({
      ...bucket,
      total: round2(bucket.activeMoney + bucket.annulledFees),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.price - b.price);

  return {
    rows,
    lines,
    voidedLines,
    buckets: bucketsSorted,
    // Active policies at their sale price, annulled ones at their fee.
    priceBuckets: priceBucketsSorted,
    activeCount,
    activeMoney,
    annulledCount,
    annulledFees,
    feesByPayer,
    // What a bill charges (every annulment fee) and what the broker balance
    // charges (only the annulment the broker is at fault for).
    billTotal: round2(activeMoney + annulledFees),
    balanceTotal: round2(activeMoney + feesByPayer.broker),
  };
}
module.exports.loadPeriodFigures = loadPeriodFigures;

/**
 * `--name=value` or `--name value`.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string|null}
 */
function argValue(args, name) {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

// The billing periods (Requests/PaymentSchedule.js) a range covers, so a
// statement that does not line up with the schedule is visible at a glance.
function periodsOf(from, to) {
  const out = [];
  let start = periodStartFor(from);
  while (start && start <= to) {
    const period = periodFor(start);
    out.push({
      periodStart: start,
      periodEnd: period.periodEnd,
      cutoff: period.cutoff,
      within: start >= from && period.periodEnd <= to,
    });
    start = period.cutoff;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const brokerArg = argValue(args, "broker");
  const from = argValue(args, "from");
  const to = argValue(args, "to");
  if (!brokerArg || !/^\d+$/.test(brokerArg)) {
    throw new Error("Pass the broker id: --broker=19");
  }
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "")) {
    throw new Error("Pass the range: --from=YYYY-MM-DD --to=YYYY-MM-DD");
  }
  if (to < from) throw new Error("--to must be on or after --from");

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
    const brokerId = Number(brokerArg);
    const [[broker]] = await conn.query(
      `SELECT id, Name, Code, CashBalance, ParentBrokerId, Deleted
         FROM brokers WHERE id = ?`,
      [brokerId]
    );
    if (!broker) throw new Error(`Broker ${brokerId} does not exist`);

    const isSub =
      Number(broker.ParentBrokerId) > 0 || isSubBrokerName(broker.Name);
    console.log(
      `Broker: ${broker.id} ${broker.Name} (${broker.Code || "-"})  ` +
        `balance ${money(broker.CashBalance).trim()}  ` +
        `sub-broker: ${isSub ? "yes" : "no"}${
          Number(broker.Deleted) ? "  DELETED" : ""
        }`
    );
    console.log(`Range:  ${from} .. ${to} (both days included, by CreationDate)`);
    for (const period of periodsOf(from, to)) {
      console.log(
        `  payment period ${period.periodStart} .. ${period.periodEnd} ` +
          `(cutoff ${period.cutoff})${
            period.within ? " - wholly inside the range" : ""
          }`
      );
    }

    const figures = await loadPeriodFigures(conn, brokerId, from, to);
    if (!figures.rows.length) {
      console.log("\nNo live policies for this broker in the range.");
      return;
    }

    console.log(
      "\nduration/type            active policies        annulled policies"
    );
    for (const bucket of figures.buckets) {
      console.log(
        `${bucket.key.padEnd(22)} ${String(bucket.activeCount).padStart(4)} ` +
          `x ${money(bucket.activeMoney)}   ${String(
            bucket.annulledCount
          ).padStart(3)} x ${money(bucket.annulledFees)}`
      );
    }
    console.log(
      `${"TOTAL".padEnd(22)} ${String(figures.activeCount).padStart(4)} ` +
        `x ${money(figures.activeMoney)}   ${String(
          figures.annulledCount
        ).padStart(3)} x ${money(figures.annulledFees)}`
    );

    // The same policies the way the broker's price list reads: how many at each
    // price per vehicle type, what they add up to, and how many of them were
    // annulled (an annulled policy sits at its annulment fee, not its price).
    console.log("\nnumber of insurances by price and vehicle type:");
    console.log(
      `${"price / type".padEnd(22)} ${"active".padStart(6)}  ` +
        `${"sum".padStart(10)}  ${"annulled".padStart(8)}  ` +
        `${"annul. fees".padStart(11)}  ${"total".padStart(10)}`
    );
    const priceTotals = {
      activeCount: 0,
      activeMoney: 0,
      annulledCount: 0,
      annulledFees: 0,
      total: 0,
    };
    for (const bucket of figures.priceBuckets) {
      priceTotals.activeCount += bucket.activeCount;
      priceTotals.activeMoney = round2(priceTotals.activeMoney + bucket.activeMoney);
      priceTotals.annulledCount += bucket.annulledCount;
      priceTotals.annulledFees = round2(
        priceTotals.annulledFees + bucket.annulledFees
      );
      priceTotals.total = round2(priceTotals.total + bucket.total);
      console.log(
        `${`${bucket.type} ${bucket.price.toFixed(2)}`.padEnd(22)} ` +
          `${String(bucket.activeCount).padStart(6)}  ` +
          `${money(bucket.activeMoney)}  ` +
          `${String(bucket.annulledCount).padStart(8)}  ` +
          `${money(bucket.annulledFees)}  ${money(bucket.total)}`
      );
    }
    console.log(
      `${"TOTAL".padEnd(22)} ${String(priceTotals.activeCount).padStart(6)}  ` +
        `${money(priceTotals.activeMoney)}  ` +
        `${String(priceTotals.annulledCount).padStart(8)}  ` +
        `${money(priceTotals.annulledFees)}  ${money(priceTotals.total)}`
    );

    console.log("\nWhat the period is worth:");
    console.log(
      `  without annulled (live policies at their Price)     = ${money(
        figures.activeMoney
      )}  (${figures.activeCount} policies)`
    );
    console.log(
      `  including annulled, bill rule (every annulment fee) = ${money(
        figures.billTotal
      )}  (${figures.activeCount + figures.annulledCount} policies)`
    );
    console.log(
      `  including annulled, balance rule (broker pays)      = ${money(
        figures.balanceTotal
      )}`
    );
    console.log(
      `  annulment fees: ${money(figures.feesByPayer.broker).trim()} paid by the ` +
        `broker, ${money(figures.feesByPayer.worker).trim()} by the worker, ` +
        `${money(figures.feesByPayer.none).trim()} with no payer`
    );

    // A statement often carries money that is not a policy: a medical insurance
    // ("Reduce") or a balance correction. Those live on the broker's ledger, so
    // they are printed next to the policy figures instead of silently adding to
    // them (`db:repair:ledger` keeps the policy side of that ledger honest).
    const [ledgerRows] = await conn.query(
      `SELECT Type, Amount, Currency, Reason, Author, CreatedAt
         FROM broker_balance_movements
        WHERE BrokerId = ? AND Deleted = 0
          AND Type IN ('reduce', 'adjust', 'increase', 'handover')
          AND CreatedAt >= ? AND CreatedAt < ?
        ORDER BY CreatedAt, id`,
      [brokerId, `${from} 00:00:00`, `${shiftDays(to, 1)} 00:00:00`]
    );
    let manualCharges = 0;
    let adjustments = 0;
    let payments = 0;
    for (const row of ledgerRows) {
      const amount = round2(row.Amount);
      if (row.Type === "reduce") {
        manualCharges = round2(manualCharges - amount);
      } else if (row.Type === "adjust") {
        adjustments = round2(adjustments - amount);
      } else {
        payments = round2(payments + amount);
      }
    }
    console.log(
      `\nBalance movements in the range that are not policies: ${ledgerRows.length}`
    );
    for (const row of ledgerRows) {
      console.log(
        `  ${String(row.CreatedAt).slice(0, 10)} ${row.Type.padEnd(8)} ` +
          `${money(row.Amount).trim().padStart(9)} ${row.Currency || "EUR"} ` +
          `by ${row.Author || "?"} - "${row.Reason || ""}"`
      );
    }
    if (manualCharges !== 0) {
      // A "Reduce" is money the broker owes that no policy explains (a medical
      // insurance, a fine...), so a statement can carry it next to the policies.
      console.log(
        `  non-policy charges (reduce)                        = ${money(
          manualCharges
        )}`
      );
      console.log(
        `  policies + non-policy charges                      = ${money(
          round2(figures.activeMoney + manualCharges)
        )} (without annulled) / ${money(
          round2(figures.activeMoney + manualCharges + figures.feesByPayer.broker)
        )} (with the broker-paid fees) / ${money(
          round2(figures.billTotal + manualCharges)
        )} (with every annulment fee)`
      );
    }
    if (adjustments !== 0) {
      // An "adjust" is an old balance correction, not a charge of the period.
      console.log(
        `  old balance corrections (adjust, NOT a period charge) = ${money(
          adjustments
        )}`
      );
    }
    if (payments !== 0) {
      console.log(
        `  money the broker paid in this range                = ${money(payments)}`
      );
    }

    // A statement that still carries a soft-deleted policy cannot be matched by
    // the bill: it is left off (the same rule as db/brokerBills.js).
    const [deletedRows] = await conn.query(
      `SELECT BlancNumber, PolicyNumber, Otomobil, Duration, Price, Annulled,
              DeletedAt, DeletedBy
         FROM insurance
        WHERE BrokerId = ? AND Deleted = 1
          AND CreationDate >= ? AND CreationDate < ?
        ORDER BY CreationDate`,
      [brokerId, `${from} 00:00:00`, `${shiftDays(to, 1)} 00:00:00`]
    );
    let deletedMoney = 0;
    for (const row of deletedRows) deletedMoney += Number(row.Price) || 0;
    console.log(
      `\nSoft-deleted in the range (never counted): ${deletedRows.length}` +
        (deletedRows.length ? `, ${money(deletedMoney).trim()} in Price` : "")
    );
    for (const row of deletedRows) {
      console.log(
        `  ${row.BlancNumber} ${row.PolicyNumber} ${row.Otomobil} ` +
          `${durationLabel(row.Duration)} ${money(row.Price).trim()}` +
          `${Number(row.Annulled) ? " (annulled)" : ""} ` +
          `- deleted ${row.DeletedAt || "?"} by ${row.DeletedBy || "?"}`
      );
    }

    if (figures.voidedLines.length) {
      console.log("\nCharges hidden on the balance history (voids, not billed):");
      for (const line of figures.voidedLines) {
        console.log(
          `  ${line.blancNumber} ${line.policyNumber} ${line.type} ` +
            `${durationLabel(line.duration)} void ${money(line.voided).trim()}`
        );
      }
    }

    const annulled = figures.lines.filter((line) => line.annulled);
    if (annulled.length) {
      console.log("\nAnnulled policies of the range:");
      for (const line of annulled) {
        console.log(
          `  ${line.blancNumber.padEnd(8)} ${line.policyNumber.padEnd(10)} ` +
            `${String(line.type).padEnd(11)} ${durationLabel(line.duration)} ` +
            `fee ${money(line.amount).trim().padStart(6)} (paid by ${line.annulReason})`
        );
      }
    }

    // The broker's own price list, so a price typed by hand stands out.
    const brokerHelpers = require("../Requests/Brokers.js");
    const pricing = await brokerHelpers.loadOwnBrokerTariffs(conn, brokerId);
    const offList = figures.lines
      .filter((line) => !line.annulled)
      .map((line) => ({
        line,
        tariff: brokerHelpers.computePolicyTariffPrice(
          { Otomobil: line.type, Duration: line.duration, NonTurk: 0 },
          pricing
        ),
      }))
      .filter(
        (entry) =>
          entry.tariff !== null &&
          round2(entry.tariff) !== round2(entry.line.amount)
      );
    console.log(
      `\nPrices different from the broker's tariff list: ${offList.length}`
    );
    for (const entry of offList.slice(0, 20)) {
      console.log(
        `  ${entry.line.blancNumber} ${entry.line.type} ` +
          `${durationLabel(entry.line.duration)} price ` +
          `${money(entry.line.amount).trim()} - tariff ${entry.tariff}`
      );
    }

    console.log(
      "\nRead-only check: nothing was written. A policy counts in the period " +
        "whose creation date falls in the range - the bill's own rule."
    );
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Broker period check failed:", err.message || err);
    process.exitCode = 1;
  });
}




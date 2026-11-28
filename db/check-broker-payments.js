"use strict";
// Read-only check of what a broker's balance is made of, for a database that
// still carries the retired "Reduce" rows and hand-typed balance corrections.
//
// Run from the repo root:
//   node --env-file=.env db/check-broker-payments.js
//   node --env-file=.env db/check-broker-payments.js --live
//
// Why: the Reduce button, POST /brokers/:id/reduce and the hand-typed balance
// correction in the broker edit form are all gone. The rows they wrote are KEPT
// as history (they still show in the balance history page) and the
// recalculation ignores them, because a balance is now
//
//   CashBalance = starting balance
//               + payments (broker_balance_movements, Type increase/handover)
//               - live policies (an annulled one at its tax only when the
//                 broker paid it, AnnulReason = 'broker')
//
// so this script shows what the retired rows contain and what each broker's
// balance becomes under that rule. The "Difference" is the amount to enter as
// that broker's starting balance (PUT /brokers/:id/starting-balance) when the
// stored figure must survive the change untouched.
//
// Nothing here writes: every statement is a SELECT.

const mysql = require("mysql2/promise");
const {
  databaseSettings,
  insuranceCharge,
} = require("./repair-broker-ledger.js");

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const money = (value) => r2(value).toFixed(2).padStart(10, " ");

/**
 * The balance the rule above computes.
 *
 * @param {{startingBalance?: number|null, payments?: number,
 *          insuranceCharges?: number}} parts
 * @returns {number}
 */
function formulaBalance({
  startingBalance = 0,
  payments = 0,
  insuranceCharges = 0,
}) {
  return r2(
    Number(startingBalance || 0) +
      Number(payments || 0) -
      Number(insuranceCharges || 0)
  );
}

/**
 * Gather everything the report prints.
 *
 * @param {{query: Function}} conn
 * @returns {Promise<{types: Array, retiredRows: Array, perBroker: Array,
 *          matching: number}>}
 */
async function loadPaymentChecks(conn) {
  const [types] = await conn.query(
    `SELECT Type,
            COUNT(*) AS RowCount,
            SUM(Deleted = 1) AS DeletedCount,
            ROUND(SUM(CASE WHEN Deleted = 0 THEN Amount ELSE 0 END), 2) AS LiveTotal,
            ROUND(SUM(CASE WHEN Deleted = 1 THEN Amount ELSE 0 END), 2) AS DeletedTotal
       FROM broker_balance_movements
      GROUP BY Type
      ORDER BY RowCount DESC, Type`
  );

  const [retiredRows] = await conn.query(
    `SELECT m.id, m.BrokerId, b.Name AS Broker, m.CreatedAt, m.Type,
            m.Amount, m.Reason, m.Author, m.Deleted
       FROM broker_balance_movements m
       LEFT JOIN brokers b ON b.id = m.BrokerId
      WHERE m.Type IN ('reduce', 'adjust')
      ORDER BY m.BrokerId, m.CreatedAt`
  );

  // A database that never ran `npm run db:setup` has no starting balances; the
  // report then reads every starting balance as 0, which is exactly what the
  // balance formula does for a broker without a row.
  let startingBalances = [];
  try {
    const [rows] = await conn.query(
      "SELECT BrokerId, Amount FROM broker_starting_balances"
    );
    startingBalances = rows;
  } catch (err) {
    if (!err || err.code !== "ER_NO_SUCH_TABLE") throw err;
  }
  const startingByBroker = new Map(
    startingBalances.map((row) => [Number(row.BrokerId), r2(row.Amount)])
  );

  const [brokers] = await conn.query(
    `SELECT id, Name, Code, CashBalance
       FROM brokers
      WHERE Deleted = 0
      ORDER BY id`
  );

  const [payments] = await conn.query(
    `SELECT BrokerId, ROUND(SUM(Amount), 2) AS Paid
       FROM broker_balance_movements
      WHERE Deleted = 0 AND Type IN ('increase', 'handover')
      GROUP BY BrokerId`
  );
  const paidByBroker = new Map(
    payments.map((row) => [Number(row.BrokerId), r2(row.Paid)])
  );

  const [policies] = await conn.query(
    `SELECT BrokerId, Price, OriginalPrice, Annulled, AnnulReason, AnnulFee,
            Deleted
       FROM insurance
      WHERE Deleted = 0 AND BrokerId IS NOT NULL`
  );
  const chargedByBroker = new Map();
  for (const policy of policies) {
    const brokerId = Number(policy.BrokerId);
    const charge = insuranceCharge(policy);
    chargedByBroker.set(
      brokerId,
      r2((chargedByBroker.get(brokerId) || 0) + charge)
    );
  }

  let matching = 0;
  const perBroker = [];
  for (const broker of brokers) {
    const brokerId = Number(broker.id);
    const startingBalance = startingByBroker.has(brokerId)
      ? startingByBroker.get(brokerId)
      : null;
    const paid = paidByBroker.get(brokerId) || 0;
    const charges = chargedByBroker.get(brokerId) || 0;
    const calculated = formulaBalance({
      startingBalance: startingBalance || 0,
      payments: paid,
      insuranceCharges: charges,
    });
    const difference = r2(Number(broker.CashBalance) - calculated);
    if (Math.abs(difference) <= 0.005) {
      matching += 1;
      continue;
    }
    perBroker.push({
      id: brokerId,
      Code: broker.Code,
      Name: broker.Name,
      storedBalance: r2(broker.CashBalance),
      startingBalance,
      payments: paid,
      insuranceCharges: charges,
      calculated,
      difference,
    });
  }
  perBroker.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  return { types, retiredRows, perBroker, matching };
}

async function main() {
  const args = process.argv.slice(2);
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
    const { types, retiredRows, perBroker, matching } =
      await loadPaymentChecks(conn);

    console.log(
      "\nMoney per movement type (a healthy database has no reduce/adjust rows):"
    );
    console.log("type              rows  deleted    live total   deleted total");
    for (const row of types) {
      console.log(
        `${String(row.Type).padEnd(16)} ${String(row.RowCount).padStart(5)} ` +
          `${String(row.DeletedCount).padStart(8)} ${money(row.LiveTotal)} ` +
          `${money(row.DeletedTotal).padStart(16)}`
      );
    }

    const retired = retiredRows.filter((row) => !Number(row.Deleted));
    console.log(
      `\nRetired reduce/adjust rows the balance ignores: ${retired.length} live` +
        ` of ${retiredRows.length} row(s)`
    );
    for (const row of retired) {
      console.log(
        `  #${String(row.id).padEnd(6)} ${String(row.Broker || "?").padEnd(28)} ` +
          `${row.CreatedAt}  ${String(row.Type).padEnd(7)} ${money(row.Amount)}  ` +
          `${row.Reason || ""}  (${row.Author || "-"})`
      );
    }

    console.log(
      "\nBalance the current rule computes, for every broker that differs from the stored figure:"
    );
    console.log(
      "id    code   broker                        stored   starting    payments      charges   calculated  difference"
    );
    for (const row of perBroker) {
      console.log(
        `${String(row.id).padEnd(5)} ${String(row.Code || "-").padEnd(6)} ` +
          `${String(row.Name).slice(0, 28).padEnd(29)} ${money(row.storedBalance)} ` +
          `${(row.startingBalance === null ? "-" : money(row.startingBalance)).padStart(10)} ` +
          `${money(row.payments).padStart(11)} ${money(row.insuranceCharges).padStart(12)} ` +
          `${money(row.calculated).padStart(12)} ${money(row.difference).padStart(11)}`
      );
    }
    if (perBroker.length === 0) {
      console.log("  (none - every stored balance already matches the rule)");
    }
    console.log(`\n${matching} broker(s) already match the rule.`);
    console.log(
      "Difference is also the starting balance to enter for that broker " +
        "(PUT /brokers/:id/starting-balance) if its current figure must stay " +
        "exactly as it is. Nothing was written."
    );
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Payment check failed:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { formulaBalance, loadPaymentChecks };

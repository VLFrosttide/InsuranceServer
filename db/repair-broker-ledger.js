"use strict";
// Patch the broker balance history (`broker_balance_movements`) once, for sale
// rows written before the server started carrying them along with a blanc
// correction.
//
// Run from the repo root:
//   node --env-file=.env db/repair-broker-ledger.js               (report only)
//   node --env-file=.env db/repair-broker-ledger.js --apply       (write fixes)
//   node --env-file=.env db/repair-broker-ledger.js --broker=35   (one broker)
//
// Why it is needed: a policy's ledger rows are keyed by its BlancNumber. When an
// admin corrected a policy's blanc, the rows written before that correction kept
// the old number, so the balance history could no longer put them together (the
// sale row showed as its own entry and lost its live-policy details). The server
// now relabels a policy's rows in the same transaction as the blanc edit; this
// script does the same once for rows written before that fix, and only when the
// pairing is unambiguous: exactly one live insurance of that broker was created
// at the same second and has no rows of its own, and exactly one such sale row
// exists for it.
//
// It never un-hides a row: a soft-deleted policy row is a VOID the balance
// honours (the broker is not charged for it), so restoring one here would change
// money. Unlike a relabel, a restore must be a deliberate action on the balance
// history page. Anything the script cannot match is printed for review.
//
// Only brokers WITH a starting balance are inspected: their figure is rebuilt
// from the insurances and the payments, and the script changes no money at all.
// The script is idempotent.

const mysql = require("mysql2/promise");

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const blancKey = (value) => String(value ?? "").trim();

// The row types the server writes from the insurance itself.
const POLICY_TYPES = new Set(["policy", "price_change", "annulment", "deletion"]);

/** The charge the balance formula applies to one insurance row. */
function insuranceCharge(row) {
  if (Number(row.Deleted) === 1) return 0;
  if (Number(row.Annulled) === 1) {
    const payer = String(row.AnnulReason ?? "").trim().toLowerCase();
    if (payer !== "broker") return 0;
    const fee =
      row.AnnulFee === null || row.AnnulFee === undefined
        ? row.Price
        : row.AnnulFee;
    return r2(fee);
  }
  return r2(row.Price);
}

/**
 * Work out the relabels for one broker without touching the database.
 *
 * @param {{id: number, Name: string, Payments: string|number}} broker
 * @param {object[]} movements   every broker_balance_movements row of the broker
 * @param {object[]} insurances  every insurance row of the broker
 * @returns {{actions: object[], unresolved: object[], history: number,
 *            expected: number}}
 */
function planBroker(broker, movements, insurances) {
  const actions = [];
  const unresolved = [];

  // A working copy, so a relabel is visible to the checks that follow it.
  const rows = movements.map((m) => ({
    id: Number(m.id),
    Type: String(m.Type ?? "").trim(),
    Amount: r2(m.Amount),
    BlancNumber: blancKey(m.BlancNumber),
    CreatedAt: String(m.CreatedAt ?? ""),
    Deleted: Number(m.Deleted) === 1,
  }));
  const policies = insurances.map((i) => ({
    BlancNumber: blancKey(i.BlancNumber),
    CreationDate: String(i.CreationDate ?? ""),
    Deleted: Number(i.Deleted) === 1,
    charge: insuranceCharge(i),
  }));

  const policyRowsFor = (blanc) =>
    rows.filter(
      (m) => POLICY_TYPES.has(m.Type) && m.BlancNumber === blanc && !m.Deleted
    );

  // --- A sale row left under a policy's previous blanc number ----------------
  const livePolicies = policies.filter((p) => !p.Deleted);
  const policiesWithoutRows = new Set(
    livePolicies
      .filter((p) => policyRowsFor(p.BlancNumber).length === 0)
      .map((p) => p.BlancNumber)
  );
  const orphanSales = rows.filter(
    (m) =>
      !m.Deleted &&
      m.Type === "policy" &&
      !livePolicies.some((p) => p.BlancNumber === m.BlancNumber)
  );

  for (const row of orphanSales) {
    // A sale row of a policy that exists (even deleted) is where it belongs.
    if (policies.some((p) => p.BlancNumber === row.BlancNumber)) continue;

    const matches = livePolicies.filter(
      (p) =>
        policiesWithoutRows.has(p.BlancNumber) &&
        p.CreationDate === row.CreatedAt
    );
    if (matches.length !== 1) {
      unresolved.push({
        broker: broker.Name,
        problem: "sale row not attached to any policy",
        movementId: row.id,
        amount: row.Amount,
        blancNumber: row.BlancNumber,
        createdAt: row.CreatedAt,
        candidates: matches.length,
      });
      continue;
    }
    const target = matches[0];
    policiesWithoutRows.delete(target.BlancNumber);
    actions.push({
      broker: broker.Name,
      kind: "relabel",
      movementId: row.id,
      from: row.BlancNumber,
      to: target.BlancNumber,
      amount: row.Amount,
    });
    row.BlancNumber = target.BlancNumber;
  }

  // --- Does the visible history add up to the balance? ----------------------
  // Balance = payments - charges - voids, and a void is a hidden row of a policy
  // that still exists (a soft-deleted insurance is charged nothing and its rows
  // are skipped by the history page), so a correct history totals exactly that.
  // A difference means a row is missing (written by an old server or deleted for
  // good) - review, do not guess.
  const liveBlancs = new Set(policies.filter((p) => !p.Deleted).map((p) => p.BlancNumber));
  const belongsToLivePolicy = (m) => liveBlancs.has(m.BlancNumber);
  const history = r2(
    rows
      .filter(
        (m) =>
          !m.Deleted &&
          m.Type !== "reduce" &&
          m.Type !== "adjust" &&
          (!POLICY_TYPES.has(m.Type) || belongsToLivePolicy(m))
      )
      .reduce((total, m) => total + m.Amount, 0)
  );
  const charges = r2(policies.reduce((total, p) => total + p.charge, 0));
  const voids = r2(
    rows
      .filter(
        (m) => m.Deleted && POLICY_TYPES.has(m.Type) && belongsToLivePolicy(m)
      )
      .reduce((total, m) => total + m.Amount, 0)
  );
  const expected = r2(r2(broker.Payments) - charges - voids);

  return { actions, unresolved, history, expected };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const brokerArg = args.map((a) => /^--broker=(\d+)$/.exec(a)).find(Boolean);
  const onlyBrokerId = brokerArg ? Number(brokerArg[1]) : null;

  const password = process.env.DB_PASSWORD;
  if (!password) throw new Error("Missing DB_PASSWORD in .env");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5500),
    user: process.env.DB_USER || "root",
    password,
    database: process.env.DB_NAME || "insurancedb",
    dateStrings: true,
  });

  const [brokers] = await conn.query(
    `SELECT b.id, b.Name,
            (SELECT COALESCE(SUM(p.Amount), 0) FROM broker_payments p
              WHERE p.BrokerId = b.id AND p.Deleted = 0
                AND p.Type IN ('increase', 'handover')) AS Payments
       FROM brokers b
       JOIN broker_starting_balances sb ON sb.BrokerId = b.id
      ${onlyBrokerId !== null ? "WHERE b.id = ?" : ""}
      ORDER BY b.id`,
    onlyBrokerId !== null ? [onlyBrokerId] : []
  );

  let relabels = 0;
  let reported = 0;
  let checked = 0;
  const allActions = [];

  for (const broker of brokers) {
    const [movements] = await conn.query(
      `SELECT id, Type, Amount, BlancNumber, CreatedAt, Deleted
         FROM broker_balance_movements WHERE BrokerId = ?`,
      [broker.id]
    );
    const [insurances] = await conn.query(
      `SELECT BlancNumber, Price, Annulled, AnnulReason, AnnulFee, Deleted,
              CreationDate
         FROM insurance WHERE BrokerId = ?`,
      [broker.id]
    );

    const plan = planBroker(broker, movements, insurances);
    const difference = r2(plan.history - plan.expected);
    if (
      plan.actions.length === 0 &&
      plan.unresolved.length === 0 &&
      difference === 0
    ) {
      continue;
    }

    checked += 1;
    console.log(
      `\n=== ${broker.Name} (#${broker.id}) - history ${plan.history.toFixed(2)}, ` +
        `balance is made of ${plan.expected.toFixed(2)}, ` +
        `difference ${difference.toFixed(2)}`
    );
    for (const action of plan.actions) {
      relabels += 1;
      console.log(
        `  relabel  movement ${action.movementId}: blanc ${action.from} -> ` +
          `${action.to} (${action.amount.toFixed(2)})`
      );
    }
    for (const item of plan.unresolved) {
      reported += 1;
      console.log(`  REPORT   ${JSON.stringify(item)}`);
    }
    allActions.push(...plan.actions);
  }

  if (allActions.length === 0) {
    console.log(
      checked === 0
        ? "\nNothing to patch: every sale row is already under its policy's blanc."
        : "\nNo sale row could be relabelled automatically - see the REPORT lines."
    );
  } else if (!apply) {
    console.log(
      `\n${allActions.length} relabel(s) available. Re-run with --apply to write them.`
    );
  } else {
    await conn.beginTransaction();
    try {
      for (const action of allActions) {
        await conn.query(
          "UPDATE broker_balance_movements SET BlancNumber = ? WHERE id = ?",
          [action.to, action.movementId]
        );
      }
      await conn.commit();
      console.log(`\nRelabelled ${allActions.length} history row(s).`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  console.log(
    `\nSummary: ${relabels} relabelled, ${reported} reported, ` +
      `${checked} broker(s) checked. brokers.CashBalance is not touched.`
  );

  await conn.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("History patch failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { planBroker, insuranceCharge };


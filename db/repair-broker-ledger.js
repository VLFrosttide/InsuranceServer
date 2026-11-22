"use strict";
// Patch the broker balance history (`broker_balance_movements`) so that every
// live insurance charged to a broker is visible on that broker's balance
// history page.
//
// Run from the repo root:
//   node --env-file=.env db/repair-broker-ledger.js               (report only)
//   node --env-file=.env db/repair-broker-ledger.js --apply       (write fixes)
//   node --env-file=.env db/repair-broker-ledger.js --broker=35   (one broker)
//   node --env-file=.env db/repair-broker-ledger.js --live        (LIVE_DB_*)
//
// Why it is needed - two kinds of stranded charge:
//
// 1) A sale row left under the policy's PREVIOUS blanc. The history pairs a
//    movement with a policy by its BlancNumber. When an admin corrected a
//    policy's blanc, the rows written before that correction kept the old
//    number, so the page could no longer attach them to the policy: a
//    policy-derivative row whose blanc belongs to no live insurance of the
//    broker is SKIPPED (keeping it would walk money the balance does not have).
//    The charge therefore vanished from the history while the insurance - and
//    the broker's charge for it - stayed. The server now relabels a policy's
//    rows in the same transaction as the blanc edit; this script does the same
//    once for rows written before that fix, and only when the pairing is
//    unambiguous: exactly one live insurance of that broker was created at the
//    same second and still has no sale row of its own, and exactly one such
//    sale row exists for it. The policy may already own other rows under its
//    current blanc (an annulment recorded after the correction, for instance).
//
// 2) A charged policy with NO row at all (neither live nor soft-deleted). An
//    older server could leave that behind, and the charge is then invisible on
//    the history page although the balance counts it. The sale row is written
//    again with the policy's charge, blanc, author and creation time. Only a
//    plain (not annulled) policy is filled in automatically; an annulled one is
//    reported for review, because its history is a sale row plus a folded
//    refund.
//
// It never un-hides a row: a soft-deleted policy row is a VOID the balance
// honours (the broker is not charged for it), so restoring one would change
// money. Unlike a relabel, a restore must be a deliberate action on the balance
// history page. Voids are listed for review.
//
// No money changes: `brokers.CashBalance` is rebuilt from the insurances and
// the payments, so writing the history row the balance always implied does not
// move the figure - it only makes the page agree with it. `brokers.CashBalance`
// is never written here.
//
// The invariant it enforces: for every live policy, the rows its history shows
// must add up to the charge the balance applies to it. A policy whose rows do
// not add up is a candidate for a relabel (the old sale row is re-attached) or
// an insert (the sale row was never written); anything else is reported.
//
// The money check compares the visible history with the figure the balance
// formula makes of it (payments - charges - voids). That is only meaningful for
// a broker with a starting balance (those balances are rebuilt from the
// insurances), so a difference is printed for them only. The missing-row audit
// itself covers EVERY broker, with or without a starting balance - a broker
// without one was the blind spot that let a charge go missing in production.
//
// The script is idempotent. Always run it without --apply first.

const mysql = require("mysql2/promise");

const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const blancKey = (value) => String(value ?? "").trim();

// The row types the server writes from the insurance itself.
const POLICY_TYPES = new Set([
  "policy",
  "price_change",
  "annulment",
  "deletion",
]);
const isPolicyType = (type) => POLICY_TYPES.has(String(type ?? "").trim());

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
 * Work out the fixes for one broker without touching the database.
 *
 * @param {{id: number, Name: string, Payments: string|number,
 *          StartingBalance: (string|number|null)=}} broker
 * @param {object[]} movements   every broker_balance_movements row of the broker
 * @param {object[]} insurances  every insurance row of the broker
 * @param {{foreignBlancs?: Set<string>}=} options  blancs that belong to a
 *        live policy of ANOTHER broker: such a sale row is a moved-away
 *        policy's history and must never be re-attached to a policy here
 * @returns {{actions: object[], inserts: object[], voids: object[],
 *            unresolved: object[], history: number, expected: number,
 *            difference: number}}
 */
function planBroker(broker, movements, insurances, options = {}) {
  const foreignBlancs =
    options.foreignBlancs instanceof Set ? options.foreignBlancs : new Set();
  const actions = [];
  const inserts = [];
  const voids = [];
  const unresolved = [];

  // A working copy, so a relabel or an insert is visible to the checks below.
  const rows = movements.map((m) => ({
    id: Number(m.id),
    Type: String(m.Type ?? "").trim(),
    Amount: r2(m.Amount),
    BlancNumber: blancKey(m.BlancNumber),
    CreatedAt: String(m.CreatedAt ?? ""),
    Deleted: Number(m.Deleted) === 1,
    Reason: String(m.Reason ?? ""),
    Author: String(m.Author ?? ""),
  }));
  const policies = insurances.map((i) => ({
    BlancNumber: blancKey(i.BlancNumber),
    PolicyNumber: String(i.PolicyNumber ?? ""),
    Author: String(i.Author ?? ""),
    CreationDate: String(i.CreationDate ?? ""),
    Deleted: Number(i.Deleted) === 1,
    annulled: Number(i.Annulled) === 1,
    charge: insuranceCharge(i),
  }));

  const livePolicies = policies.filter((p) => !p.Deleted);
  const liveBlancs = new Set(livePolicies.map((p) => p.BlancNumber));
  // Every blanc this broker ever had, deleted policies included: their rows
  // belong to them and are hidden on purpose.
  const knownBlancs = new Set(policies.map((p) => p.BlancNumber));

  const liveRowsFor = (blanc) =>
    rows.filter(
      (m) => isPolicyType(m.Type) && !m.Deleted && m.BlancNumber === blanc
    );
  const anyRowsFor = (blanc) =>
    rows.filter((m) => isPolicyType(m.Type) && m.BlancNumber === blanc);

  const liveNetFor = (blanc) =>
    r2(liveRowsFor(blanc).reduce((total, m) => total + m.Amount, 0));

  // A policy is "off" when the rows its history shows do not add up to the
  // charge the balance applies to it (that charge is positive on the balance,
  // so its rows must total the negative of it). An annulled policy is NOT off
  // just because its sale folds away: the refund it keeps is its visible money
  // and the amounts still have to agree with the tax the balance charges.
  const offPolicies = livePolicies.filter(
    (p) => Math.abs(liveNetFor(p.BlancNumber) + p.charge) >= 0.005
  );

  // --- A sale row left under a policy's previous blanc ----------------------
  // Only a policy whose own blanc has no sale row can take an orphan sale row:
  // attaching a second sale to a policy that already shows one would count the
  // same charge twice.
  const policiesWithoutSale = new Set(
    offPolicies
      .filter(
        (p) => !liveRowsFor(p.BlancNumber).some((m) => m.Type === "policy")
      )
      .map((p) => p.BlancNumber)
  );
  const orphanSales = rows.filter(
    (m) =>
      !m.Deleted &&
      m.Type === "policy" &&
      !knownBlancs.has(m.BlancNumber) &&
      !foreignBlancs.has(m.BlancNumber)
  );

  for (const row of orphanSales) {
    const matches = livePolicies.filter(
      (p) =>
        policiesWithoutSale.has(p.BlancNumber) &&
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
    policiesWithoutSale.delete(target.BlancNumber);
    actions.push({
      broker: broker.Name,
      movementId: row.id,
      from: row.BlancNumber,
      to: target.BlancNumber,
      amount: row.Amount,
    });
    row.BlancNumber = target.BlancNumber;
  }

  // --- A charged policy the history still cannot show -----------------------
  const belongsToLivePolicy = (m) => liveBlancs.has(m.BlancNumber);

  for (const p of offPolicies) {
    const liveRows = liveRowsFor(p.BlancNumber);
    const net = liveNetFor(p.BlancNumber);
    if (Math.abs(net + p.charge) < 0.005) continue; // a relabel above fixed it
    if (liveRows.length > 0) {
      unresolved.push({
        broker: broker.Name,
        problem: "history of the policy does not add up to its charge",
        blancNumber: p.BlancNumber,
        policyNumber: p.PolicyNumber,
        charge: p.charge,
        visibleNet: net,
        rows: liveRows.map((m) => `${m.id}:${m.Type}:${m.Amount}`),
      });
      continue;
    }

    const voidedRows = anyRowsFor(p.BlancNumber).filter((m) => m.Deleted);
    if (voidedRows.length > 0) {
      // A void is a deliberate "do not charge the broker for this policy".
      // Restoring it would change money, so it is only reported here.
      voids.push({
        broker: broker.Name,
        blancNumber: p.BlancNumber,
        policyNumber: p.PolicyNumber,
        charge: p.charge,
        voidedRows: voidedRows.map(
          (m) => `${m.id}:${m.Type}:${m.Amount} (${m.Reason})`
        ),
      });
      continue;
    }

    if (p.annulled) {
      unresolved.push({
        broker: broker.Name,
        problem: "annulled policy has no ledger row",
        blancNumber: p.BlancNumber,
        policyNumber: p.PolicyNumber,
        charge: p.charge,
      });
      continue;
    }

    // The same money may already be recorded under a blanc that could not be
    // matched above (two policies at the same second). Inserting another sale
    // row would double-count it in the bi-weekly reports, so report instead.
    const twin = rows.find(
      (m) =>
        !m.Deleted &&
        m.Type === "policy" &&
        m.Amount === -p.charge &&
        m.CreatedAt === p.CreationDate
    );
    if (twin) {
      unresolved.push({
        broker: broker.Name,
        problem: "sale row exists under another blanc",
        movementId: twin.id,
        blancNumber: twin.BlancNumber,
        policyNumber: p.PolicyNumber,
        charge: p.charge,
      });
      continue;
    }

    inserts.push({
      broker: broker.Name,
      brokerId: Number(broker.id),
      blancNumber: p.BlancNumber,
      policyNumber: p.PolicyNumber,
      amount: -p.charge,
      author: p.Author,
      createdAt: p.CreationDate,
    });
    // Make the new row visible to the money check below.
    rows.push({
      id: 0,
      Type: "policy",
      Amount: -p.charge,
      BlancNumber: p.BlancNumber,
      CreatedAt: p.CreationDate,
      Deleted: false,
      Reason: p.BlancNumber,
      Author: p.Author,
    });
  }

  // --- Does the visible history add up to the balance? ----------------------
  // Balance = payments - charges - voids, and a void is a hidden row of a live
  // policy, so a correct history totals exactly that. A difference means a row
  // is still missing (or extra) - review, do not guess.
  const history = r2(
    rows
      .filter(
        (m) =>
          !m.Deleted &&
          m.Type !== "reduce" &&
          m.Type !== "adjust" &&
          (!isPolicyType(m.Type) || belongsToLivePolicy(m))
      )
      .reduce((total, m) => total + m.Amount, 0)
  );
  const charges = r2(policies.reduce((total, p) => total + p.charge, 0));
  const voidedAmount = r2(
    rows
      .filter(
        (m) => m.Deleted && isPolicyType(m.Type) && belongsToLivePolicy(m)
      )
      .reduce((total, m) => total + m.Amount, 0)
  );
  const expected = r2(r2(broker.Payments) - charges - voidedAmount);

  return {
    actions,
    inserts,
    voids,
    unresolved,
    history,
    expected,
    difference: r2(history - expected),
  };
}

// Read the database settings the script should use. Without --live it targets
// DB_* (the local database the server runs against); with --live it targets the
// LIVE_DB_* block, so production can be audited and repaired from the same
// script. The password is never printed.
function databaseSettings(args) {
  const live = args.includes("--live");
  const prefix = live ? "LIVE_DB_" : "DB_";
  const settings = {
    live,
    host: process.env[`${prefix}HOST`] || "localhost",
    port: Number(process.env[`${prefix}PORT`] || 5500),
    user: process.env[`${prefix}USER`] || "root",
    password: process.env[`${prefix}PASSWORD`],
    database: process.env[`${prefix}NAME`] || "insurancedb",
  };
  if (!settings.password) {
    throw new Error(`Missing ${prefix}PASSWORD in .env`);
  }
  return settings;
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

  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    dateStrings: true,
  });

  const [brokers] = await conn.query(
    `SELECT b.id, b.Name, b.Code,
            (SELECT COALESCE(SUM(p.Amount), 0) FROM broker_payments p
              WHERE p.BrokerId = b.id AND p.Deleted = 0
                AND p.Type IN ('increase', 'handover')) AS Payments,
            (SELECT sb.Amount FROM broker_starting_balances sb
              WHERE sb.BrokerId = b.id) AS StartingBalance
       FROM brokers b
      WHERE b.Deleted = 0
        ${onlyBrokerId !== null ? "AND b.id = ?" : ""}
      ORDER BY b.id`,
    onlyBrokerId !== null ? [onlyBrokerId] : []
  );

  const allActions = [];
  const allInserts = [];
  let voidsReported = 0;
  let unresolvedReported = 0;
  let checked = 0;

  // Every live policy's blanc and owner, read once: a sale row under a blanc
  // that belongs to another broker is the history of a policy that moved away,
  // and must never be re-attached to a policy of this broker.
  const [allLivePolicies] = await conn.query(
    "SELECT BlancNumber, BrokerId FROM insurance WHERE Deleted = 0"
  );
  const ownerByBlanc = new Map(
    (allLivePolicies || []).map((p) => [
      blancKey(p.BlancNumber),
      Number(p.BrokerId),
    ])
  );

  for (const broker of brokers) {
    const foreignBlancs = new Set();
    for (const [blanc, owner] of ownerByBlanc) {
      if (owner !== Number(broker.id)) foreignBlancs.add(blanc);
    }
    const [movements] = await conn.query(
      `SELECT id, Type, Amount, BlancNumber, Reason, Author, CreatedAt, Deleted
         FROM broker_balance_movements WHERE BrokerId = ?`,
      [broker.id]
    );
    const [insurances] = await conn.query(
      `SELECT BlancNumber, PolicyNumber, Author, Price, Annulled, AnnulReason,
              AnnulFee, Deleted, CreationDate
         FROM insurance WHERE BrokerId = ?`,
      [broker.id]
    );

    const plan = planBroker(broker, movements, insurances, { foreignBlancs });
    const hasStartingBalance =
      broker.StartingBalance !== null && broker.StartingBalance !== undefined;
    const differenceShown = hasStartingBalance ? plan.difference : null;

    if (
      plan.actions.length === 0 &&
      plan.inserts.length === 0 &&
      plan.voids.length === 0 &&
      plan.unresolved.length === 0 &&
      (differenceShown === null || differenceShown === 0)
    ) {
      continue;
    }

    checked += 1;
    console.log(
      `\n=== ${broker.Name} (#${broker.id}, ${broker.Code}) - ` +
        `history ${plan.history.toFixed(2)}` +
        (differenceShown === null
          ? ", no starting balance (the balance formula is not checked here)"
          : `, balance is made of ${plan.expected.toFixed(2)}, ` +
            `difference ${differenceShown.toFixed(2)}`)
    );
    for (const action of plan.actions) {
      console.log(
        `  relabel  movement ${action.movementId}: blanc ${action.from} -> ` +
          `${action.to} (${action.amount.toFixed(2)})`
      );
    }
    for (const insert of plan.inserts) {
      console.log(
        `  INSERT   missing sale row for ${insert.blancNumber} ` +
          `(policy ${insert.policyNumber}, ${insert.amount.toFixed(2)}, ` +
          `${insert.createdAt}, author ${insert.author || "-"})`
      );
    }
    for (const item of plan.voids) {
      voidsReported += 1;
      console.log(
        `  VOID     ${item.blancNumber} (policy ${item.policyNumber}) is not ` +
          `charged: ${item.voidedRows.join(", ")} - restore it on the history ` +
          `page if the broker should pay for it`
      );
    }
    for (const item of plan.unresolved) {
      unresolvedReported += 1;
      console.log(`  REPORT   ${JSON.stringify(item)}`);
    }
    if (differenceShown !== null && differenceShown !== 0) {
      console.log(
        `  REVIEW   history and balance still differ by ` +
          `${differenceShown.toFixed(2)} - inspect the lines above`
      );
    }

    allActions.push(...plan.actions);
    allInserts.push(...plan.inserts);
  }

  if (allActions.length === 0 && allInserts.length === 0) {
    console.log(
      checked === 0
        ? "\nNothing to patch: every charged policy is already in its broker's history."
        : "\nNo row could be relabelled or inserted - see the REPORT lines."
    );
  } else if (!apply) {
    console.log(
      `\n${allActions.length} relabel(s) and ${allInserts.length} missing sale ` +
        `row(s) available. Re-run with --apply to write them.`
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
      for (const insert of allInserts) {
        // The same columns a policy's sale row is written with by the server
        // (recordBrokerMovement): the reason is the blanc, Branch stays NULL so
        // the row is never Cash from Brokers.
        await conn.query(
          `INSERT INTO broker_balance_movements
             (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
           VALUES (?, ?, 'policy', ?, ?, ?, ?)`,
          [
            insert.brokerId,
            insert.amount,
            insert.blancNumber,
            insert.author,
            insert.blancNumber,
            insert.createdAt,
          ]
        );
      }
      await conn.commit();
      console.log(
        `\nRelabelled ${allActions.length} history row(s) and wrote ` +
          `${allInserts.length} missing sale row(s).`
      );
    } catch (err) {
      await conn.rollback();
      throw err;
    }

    // Link the policies this run put right (insurance.SaleMovementId), so the
    // pairing no longer depends on the blanc. A database that has not added the
    // column yet simply says so - `npm run db:link:sales -- --apply` does it.
    try {
      const { backfillSaleLinks } = require("./link-insurance-sales.js");
      const linked = await backfillSaleLinks(conn);
      if (linked) {
        console.log(`Linked ${linked} policy(ies) to their sale row.`);
      }
    } catch (err) {
      console.log(
        "Could not link the policies to their sale rows " +
          `(${(err && err.message) || err}); run npm run db:link:sales -- --apply.`
      );
    }
  }

  console.log(
    `\nSummary: ${allActions.length} relabel(s), ${allInserts.length} insert(s)` +
      `${apply ? " written" : " found (nothing written - run with --apply)"}, ` +
      `${voidsReported} void(s) reported, ${unresolvedReported} problem(s) ` +
      `reported, ${checked} broker(s) checked. brokers.CashBalance is not touched.`
  );

  await conn.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("History patch failed:", err);
    process.exitCode = 1;
  });
}

module.exports = { planBroker, insuranceCharge, databaseSettings };

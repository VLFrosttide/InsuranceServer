"use strict";
// Payment and cash-inflow reports for the InsuranceWebsite dashboard.
//
//   GET /reports/payments?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /reports/cash-inflow?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns the walk-in payments collected at the two border crossings
// (Kapitan Andreevo and Lesovo), split by cash vs. card, plus the total
// broker balance (the sum of broker-attributed policies' net value), all
// within an inclusive date range. Only admins (role 1) and workers (role 2)
// may call it: a broker (role 3) account never sees the company-wide report.
//
// A walk-in policy (BrokerId IS NULL) is the money physically collected at a
// crossing: PaymentType is "Cash" or "Card", and the crossing is stored on the
// `Branch` column. The net contribution of a policy is its full price while
// active, or just the annul fee once annulled; deleted policies contribute
// nothing. Everything is keyed on the policy's creation date.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { brokerNameMatches } = require("./TierEndpoints.js");

// Query terms matched (script-insensitively) against the stored branch name.
// "kap andreevo" prefixes "kapitan" so it matches "ГКПП Капитан Андреево".
const KAP_ANDREEVO_QUERY = "kap andreevo";
const LESOVO_QUERY = "lesovo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n) => Math.round(n * 100) / 100;
const round0 = (n) => Math.round(Number(n) || 0);

// Add one day to a "YYYY-MM-DD" string, returning a "YYYY-MM-DD" string.
function addOneDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * Create the Reports router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createReportsRouter = function createReportsRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireReportRole = requireRole(1, 2);

  // GET /reports/payments — cash/card totals for Kapitan Andreevo and Lesovo.
  router.get("/reports/payments", auth, requireReportRole, async (req, res) => {
    try {
      const fromRaw = req.query.from ? String(req.query.from).trim() : "";
      const toRaw = req.query.to ? String(req.query.to).trim() : "";

      if (!fromRaw || !toRaw) {
        return res
          .status(400)
          .json({ error: "from and to are required (YYYY-MM-DD)" });
      }
      if (!DATE_RE.test(fromRaw) || !DATE_RE.test(toRaw)) {
        return res
          .status(400)
          .json({ error: "from/to must be in YYYY-MM-DD format" });
      }
      if (fromRaw > toRaw) {
        return res.status(400).json({ error: "from must be on or before to" });
      }

      // Inclusive [from, to] range in the client's local day, matching the rest
      // of the API (CreationDate is compared against local date boundaries).
      const fromParam = fromRaw;
      const toParam = addOneDay(toRaw);

      // Aggregate walk-in Cash/Card policies by branch and payment type. Sums
      // across currencies (EUR/TRY) into a single figure per metric, which
      // is what the website's single-number report expects.
      const [rows] = await DBConnection.query(
        `SELECT Branch, PaymentType,
                ROUND(SUM(CASE
                  WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                  ELSE COALESCE(AnnulFee, 0)
                END), 2) AS Net
           FROM insurance
          WHERE BrokerId IS NULL AND Deleted = 0
            AND PaymentType IN ('Cash', 'Card')
            AND CreationDate >= ? AND CreationDate < ?
          GROUP BY Branch, PaymentType
          ORDER BY Branch, PaymentType`,
        [fromParam, toParam]
      );

      // "Total broker balance" for the report = the sum of the net value of
      // broker-attributed policies created within the range. It mirrors the
      // walk-in net-value convention above (full price while active, annul fee
      // once annulled, deleted policies contribute nothing) and is keyed on the
      // policy's creation date.
      const [[brokerAgg]] = await DBConnection.query(
        `SELECT ROUND(SUM(CASE
                  WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                  ELSE COALESCE(AnnulFee, 0)
                END), 2) AS Net
           FROM insurance
          WHERE BrokerId IS NOT NULL AND Deleted = 0
            AND CreationDate >= ? AND CreationDate < ?`,
        [fromParam, toParam]
      );
      const brokerBalance = round2(Number(brokerAgg && brokerAgg.Net) || 0);

      const totals = {
        kapAndreevoCash: 0,
        kapAndreevoCard: 0,
        lesovoCash: 0,
        lesovoCard: 0,
      };

      for (const row of rows) {
        const branch = String(row.Branch || "");
        const isCash = String(row.PaymentType).toLowerCase() === "cash";
        const net = Number(row.Net) || 0;

        if (brokerNameMatches(branch, KAP_ANDREEVO_QUERY)) {
          if (isCash) totals.kapAndreevoCash += net;
          else totals.kapAndreevoCard += net;
        } else if (brokerNameMatches(branch, LESOVO_QUERY)) {
          if (isCash) totals.lesovoCash += net;
          else totals.lesovoCard += net;
        }
        // Any other branch (e.g. the Harmanli office) is not part of the report.
      }

      res.json({
        brokerBalance,
        kapAndreevoCash: round2(totals.kapAndreevoCash),
        kapAndreevoCard: round2(totals.kapAndreevoCard),
        lesovoCash: round2(totals.lesovoCash),
        lesovoCard: round2(totals.lesovoCard),
      });
    } catch (err) {
      console.error("Reports payments lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch payment report" });
    }
  });

  // GET /reports/cash-inflow — per-broker cash-flow summary for a date range.
  //
  // Returns, for every broker with activity in the range (or a balance carried
  // into it), four whole-number figures:
  //   totalOwed      — net value of the insurances the broker made in the period
  //                    (full price while active, the annul fee once annulled,
  //                    nothing once deleted).
  //   amount         — cash actually received from the broker ("increase"
  //                    movements on the balance ledger).
  //   weeklyBalance  — totalOwed - amount (this cycle only, no leftover).
  //   leftover       — the balance carried over from previous cycles, expressed
  //                    as "owed": positive when the broker still owes, negative
  //                    when they overpaid.
  router.get("/reports/cash-inflow", auth, requireReportRole, async (req, res) => {
    try {
      const fromRaw = req.query.from ? String(req.query.from).trim() : "";
      const toRaw = req.query.to ? String(req.query.to).trim() : "";

      if (!fromRaw || !toRaw) {
        return res
          .status(400)
          .json({ error: "from and to are required (YYYY-MM-DD)" });
      }
      if (!DATE_RE.test(fromRaw) || !DATE_RE.test(toRaw)) {
        return res
          .status(400)
          .json({ error: "from/to must be in YYYY-MM-DD format" });
      }
      if (fromRaw > toRaw) {
        return res.status(400).json({ error: "from must be on or before to" });
      }

      // Movements are keyed on the client's local wall-clock time; insurances
      // are keyed on their creation date (matching /reports/payments).
      const fromParam = fromRaw + " 00:00:00";
      const toParam = addOneDay(toRaw) + " 00:00:00";
      const fromDay = fromRaw;
      const toDay = addOneDay(toRaw);

      // 1) Cash inflow: money received from the broker within the period.
      const [inflowRows] = await DBConnection.query(
        `SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS amount
           FROM broker_balance_movements
          WHERE Type = 'increase' AND Amount > 0 AND Deleted = 0
            AND CreatedAt >= ? AND CreatedAt < ?
          GROUP BY BrokerId`,
        [fromParam, toParam]
      );

      // 2) Total owed: net value of broker insurances created within the period.
      const [owedRows] = await DBConnection.query(
        `SELECT BrokerId AS brokerId,
                ROUND(SUM(CASE
                  WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                  ELSE COALESCE(AnnulFee, 0)
                END), 2) AS totalOwed
           FROM insurance
          WHERE BrokerId IS NOT NULL AND Deleted = 0
            AND CreationDate >= ? AND CreationDate < ?
          GROUP BY BrokerId`,
        [fromDay, toDay]
      );

      // 3) Leftover: the ledger balance before the period start. The ledger is
      //    signed (negative = owes), so negate it to express "owed" (positive =
      //    still owes).
      const [leftoverRows] = await DBConnection.query(
        `SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS balanceBefore
           FROM broker_balance_movements
          WHERE Deleted = 0 AND CreatedAt < ?
          GROUP BY BrokerId`,
        [fromParam]
      );

      // Merge the three aggregates per broker.
      const byId = new Map();
      const ensure = (id) => {
        if (!byId.has(id)) {
          byId.set(id, { brokerId: id, totalOwed: 0, amount: 0, leftover: 0 });
        }
        return byId.get(id);
      };
      for (const r of inflowRows) ensure(r.brokerId).amount = Number(r.amount) || 0;
      for (const r of owedRows) ensure(r.brokerId).totalOwed = Number(r.totalOwed) || 0;
      for (const r of leftoverRows) {
        ensure(r.brokerId).leftover = -(Number(r.balanceBefore) || 0);
      }

      // Only brokers with something to show (owed, paid, or carried over).
      const merged = [...byId.values()].filter(
        (r) => r.totalOwed !== 0 || r.amount !== 0 || r.leftover !== 0
      );

      // Resolve broker names.
      const [nameRows] = await DBConnection.query("SELECT id, Name FROM brokers");
      const nameById = new Map((nameRows || []).map((b) => [b.id, b.Name]));

      const brokers = merged.map((r) => {
        const totalOwed = round0(r.totalOwed);
        const amount = round0(r.amount);
        const leftover = round0(r.leftover);
        return {
          brokerId: r.brokerId,
          brokerName: nameById.get(r.brokerId) || null,
          totalOwed,
          amount,
          leftover,
          weeklyBalance: totalOwed - amount,
        };
      });

      // Most-indebted first.
      brokers.sort(
        (a, b) =>
          b.leftover + b.weeklyBalance - (a.leftover + a.weeklyBalance) ||
          b.totalOwed - a.totalOwed
      );

      res.json({ brokers });
    } catch (err) {
      console.error("Reports cash inflow lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch cash inflow report" });
    }
  });

  return router;
};

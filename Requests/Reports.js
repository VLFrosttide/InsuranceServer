"use strict";
// Payment, cash-inflow and shift-productivity reports for the InsuranceWebsite
// dashboard.
//
//   GET /reports/payments?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /reports/cash-inflow?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /reports/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD[&dayStart=07:30&nightStart=19:30]
//
// Returns the walk-in payments collected at the two border crossings
// (Kapitan Andreevo and Lesovo), split by cash vs. card, plus the total
// broker balance (the sum of broker-attributed policies' net value), all
// within an inclusive date range; a per-broker cash-flow summary; and how many
// insurances each worker created per day/night shift (with the averages for
// each). Only admins (role 1) and workers (role 2) may call them: a broker
// (role 3) account never sees the company-wide reports.
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

// Add a number of days to a "YYYY-MM-DD" string, returning a "YYYY-MM-DD"
// string. UTC arithmetic, so a daylight-saving change can never make a period
// one day shorter.
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const stamp = new Date(Date.UTC(y, m - 1, d + Number(days)));
  const p = (n) => String(n).padStart(2, "0");
  return (
    stamp.getUTCFullYear() +
    "-" +
    p(stamp.getUTCMonth() + 1) +
    "-" +
    p(stamp.getUTCDate())
  );
}

// Add one day to a "YYYY-MM-DD" string, returning a "YYYY-MM-DD" string.
function addOneDay(dateStr) {
  return addDays(dateStr, 1);
}

// Number of calendar days in the inclusive [from, to] range.
function countDays(fromStr, toStr) {
  const [y1, m1, d1] = String(fromStr).split("-").map(Number);
  const [y2, m2, d2] = String(toStr).split("-").map(Number);
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.round((end - start) / 86400000) + 1;
}

// Shared `?from=&to=` validation for the reports below. Returns either
// `{ from, to }` or `{ error }`, so every report rejects a bad range the same
// way.
function parseDateRange(query) {
  const fromRaw = query && query.from ? String(query.from).trim() : "";
  const toRaw = query && query.to ? String(query.to).trim() : "";

  if (!fromRaw || !toRaw) {
    return { error: "from and to are required (YYYY-MM-DD)" };
  }
  if (!DATE_RE.test(fromRaw) || !DATE_RE.test(toRaw)) {
    return { error: "from/to must be in YYYY-MM-DD format" };
  }
  if (fromRaw > toRaw) {
    return { error: "from must be on or before to" };
  }
  return { from: fromRaw, to: toRaw };
}

// ---------------------------------------------------------------------------
// Shift productivity report.
//
// There is no shift table. Each employee's policies are cut into STREAKS: a
// pause longer than `maxGapMinutes` between two of their insurances starts a new
// shift, so a shift ENDS at the last insurance of the streak (around 07:30 /
// 19:30 at the crossings, but never exactly) and the next one begins at the
// first insurance after it. Each streak is then labelled day or night by the
// nominal windows (07:30-19:30 and the rest), using the MAJORITY of its
// policies - so one early arrival or one late departure does not split a shift
// in two, and an after-midnight tail still counts as night. A night streak that
// starts before the day shift is dated the previous day, so 03:00 on the 22nd
// belongs to the night of the 21st - how the crossings work, and how the
// drawer's "End shift" closes them.
// ---------------------------------------------------------------------------
const DEFAULT_DAY_START = "07:30";
const DEFAULT_NIGHT_START = "19:30";

// "07:30" / "7:30" / "7" -> minutes of the day; null when it is not a time.
// A bare hour means that hour sharp, so an older `?dayStart=7` still works.
function parseShiftTime(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// Minutes of the day -> "07:30".
function shiftTimeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Read one `?dayStart=` / `?nightStart=` value, falling back to the default
// when the parameter is absent. Returns null when the value is not a time.
function readShiftTime(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return parseShiftTime(fallback);
  }
  return parseShiftTime(raw);
}

// Minutes of silence that END a shift: a pause longer than this between two
// insurances of the same employee starts a new shift, so the shift ends at the
// LAST policy of the streak. The crossings work 12-hour shifts, so the default
// of 6 hours sits comfortably between a quiet stretch inside one shift and the
// gap between two shifts.
const DEFAULT_MAX_GAP_MINUTES = 360;

// `?gap=360` (minutes) -> the pause that ends a shift, or null when invalid.
function readGapMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_GAP_MINUTES;
  }
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const value = Number(text);
  if (value < 15 || value > 1440) return null;
  return value;
}

// `?dayStart=07:30&nightStart=19:30&gap=360` -> validated settings, in minutes.
function resolveShiftTimes(query) {
  const dayStartMinutes = readShiftTime(query && query.dayStart, DEFAULT_DAY_START);
  const nightStartMinutes = readShiftTime(
    query && query.nightStart,
    DEFAULT_NIGHT_START
  );
  const gapMinutes = readGapMinutes(query && query.gap);

  if (dayStartMinutes === null) {
    return { error: "dayStart must be a time of day in HH:MM format" };
  }
  if (nightStartMinutes === null) {
    return { error: "nightStart must be a time of day in HH:MM format" };
  }
  if (nightStartMinutes === dayStartMinutes) {
    return { error: "nightStart must be different from dayStart" };
  }
  if (nightStartMinutes < dayStartMinutes) {
    return {
      error:
        "nightStart must be later than dayStart (the day shift cannot cross midnight)",
    };
  }
  if (gapMinutes === null) {
    return { error: "gap must be a number of minutes between 15 and 1440" };
  }
  return { dayStartMinutes, nightStartMinutes, gapMinutes };
}

// Averages of one bucket of rows (day, night, or both), one field at a time
// because "average" is ambiguous here:
//   policies                    insurances created in the bucket
//   workers                     distinct people who created them
//   shifts                      distinct worker-shifts (one person on one shift
//                               date) that produced at least one policy
//   activeDays                  distinct shift dates with activity
//   avgPoliciesPerShift         policies / shifts (one person, one shift)
//   avgPoliciesPerWorker        policies / workers
//   avgPoliciesPerDay           policies / every day of the range
//   avgPoliciesPerWorkerPerDay  policies / (workers * days of the range)
function summarizeShift(list, days) {
  const policies = list.reduce((total, row) => total + row.policies, 0);
  const workers = new Set(list.map((row) => row.worker)).size;
  const shifts = list.length;
  const activeDays = new Set(list.map((row) => row.date)).size;
  return {
    policies,
    workers,
    shifts,
    activeDays,
    avgPoliciesPerShift: shifts > 0 ? round2(policies / shifts) : 0,
    avgPoliciesPerWorker: workers > 0 ? round2(policies / workers) : 0,
    avgPoliciesPerDay: days > 0 ? round2(policies / days) : 0,
    avgPoliciesPerWorkerPerDay:
      workers > 0 && days > 0 ? round2(policies / (workers * days)) : 0,
  };
}

// The same averages for one person's bucket. Their own `workers` would always
// be 1, so only the useful figures are kept.
function summarizeWorkerShift(list, days) {
  const policies = list.reduce((total, row) => total + row.policies, 0);
  const shifts = list.length;
  const activeDays = new Set(list.map((row) => row.date)).size;
  return {
    policies,
    shifts,
    activeDays,
    avgPoliciesPerShift: shifts > 0 ? round2(policies / shifts) : 0,
    avgPoliciesPerDay: days > 0 ? round2(policies / days) : 0,
  };
}


/**
 * Build the shift productivity report: how many insurances every worker
 * created per shift (day vs night) in an inclusive date range, plus the
 * averages for each shift and each worker.
 *
 * A shift is a STREAK of policies of one employee: a pause longer than
 * `gapMinutes` between two of them starts a new shift, so a shift ends at the
 * last insurance of the streak (which is around 07:30 / 19:30, but never
 * exactly - and that is the point). Each streak is labelled day or night by
 * where the majority of its policies fall in the nominal windows, so an early
 * arrival or a late departure does not split a shift in two, and a short
 * after-midnight tail still counts as the night it belongs to.
 *
 * Nothing is written; only `insurance` and `users` are read.
 *
 * @param {{query: Function}} conn
 * @param {{from: string, to: string, dayStartMinutes?: number,
 *          nightStartMinutes?: number, gapMinutes?: number}} options
 */
async function buildShiftReport(conn, options) {
  const from = String(options.from);
  const to = String(options.to);
  const dayStartMinutes =
    options.dayStartMinutes === undefined
      ? parseShiftTime(DEFAULT_DAY_START)
      : Number(options.dayStartMinutes);
  const nightStartMinutes =
    options.nightStartMinutes === undefined
      ? parseShiftTime(DEFAULT_NIGHT_START)
      : Number(options.nightStartMinutes);
  const gapMinutes =
    options.gapMinutes === undefined
      ? DEFAULT_MAX_GAP_MINUTES
      : Number(options.gapMinutes);
  if (
    !Number.isInteger(dayStartMinutes) ||
    !Number.isInteger(nightStartMinutes) ||
    dayStartMinutes < 0 ||
    nightStartMinutes > 1439 ||
    nightStartMinutes <= dayStartMinutes
  ) {
    throw new Error(
      "Invalid shift window: the night shift must start after the day shift"
    );
  }
  if (!Number.isInteger(gapMinutes) || gapMinutes < 15) {
    throw new Error("Invalid shift gap: it must be at least 15 minutes");
  }
  const days = countDays(from, to);

  // The scan reaches a day before the range and two days after it, so a streak
  // that straddles an edge is still one streak (its own date below decides
  // whether it belongs to the report).
  //
  // The worker is the CANONICAL account name (users.Username), not the casing
  // typed at login: insurance.Author keeps whatever was typed, so the same
  // person appears as DARIA and daria. Users are matched case-insensitively
  // (the utf8mb4_0900_ai_ci collation), and an author with no account any more
  // keeps the stored name.
  const [rawRows] = await conn.query(
    `WITH ordered AS (
       SELECT Author,
              CreationDate,
              LAG(CreationDate) OVER (
                PARTITION BY Author ORDER BY CreationDate
              ) AS PrevDate
         FROM insurance
        WHERE Deleted = 0 AND CreationDate >= ? AND CreationDate < ?
     ),
     marked AS (
       SELECT Author,
              CreationDate,
              SUM(CASE WHEN PrevDate IS NULL
                         OR TIMESTAMPDIFF(MINUTE, PrevDate, CreationDate) > ?
                       THEN 1 ELSE 0 END) OVER (
                PARTITION BY Author ORDER BY CreationDate
              ) AS StreakNo,
              CASE WHEN (HOUR(CreationDate) * 60 + MINUTE(CreationDate)) >= ?
                        AND (HOUR(CreationDate) * 60 + MINUTE(CreationDate)) < ?
                   THEN 1 ELSE 0 END AS InDayWindow
         FROM ordered
     ),
     streaks AS (
       SELECT Author,
              StreakNo,
              MIN(CreationDate) AS StartedAt,
              MAX(CreationDate) AS EndedAt,
              COUNT(*) AS Policies,
              SUM(InDayWindow) AS DayPolicies
         FROM marked
        GROUP BY Author, StreakNo
     )
     SELECT DATE_FORMAT(r.ShiftDate, '%Y-%m-%d') AS shiftDate,
            r.ShiftType AS shiftType,
            r.worker AS worker,
            r.role AS role,
            DATE_FORMAT(r.StartedAt, '%Y-%m-%d %H:%i') AS startedAt,
            DATE_FORMAT(r.EndedAt, '%Y-%m-%d %H:%i') AS endedAt,
            r.Policies AS policies
       FROM (
         SELECT CASE
                  WHEN (HOUR(s.StartedAt) * 60 + MINUTE(s.StartedAt)) < ?
                       AND s.DayPolicies * 2 < s.Policies
                  THEN DATE_SUB(DATE(s.StartedAt), INTERVAL 1 DAY)
                  ELSE DATE(s.StartedAt)
                END AS ShiftDate,
                CASE WHEN s.DayPolicies * 2 >= s.Policies
                     THEN 'day' ELSE 'night' END AS ShiftType,
                COALESCE(u.Username, s.Author) AS worker,
                u.Role AS role,
                s.StartedAt AS StartedAt,
                s.EndedAt AS EndedAt,
                s.Policies AS Policies
           FROM streaks s
           LEFT JOIN users u ON u.Username = s.Author
       ) r
      WHERE r.ShiftDate >= ? AND r.ShiftDate < ?
      ORDER BY r.ShiftDate, r.ShiftType DESC, r.Policies DESC, r.worker`,
    [
      addDays(from, -1) + " 00:00:00",
      addDays(to, 2) + " 00:00:00",
      gapMinutes,
      dayStartMinutes,
      nightStartMinutes,
      dayStartMinutes,
      from,
      addOneDay(to),
    ]
  );

  const rows = (rawRows || []).map((row) => ({
    date: String(row.shiftDate),
    shift: row.shiftType === "night" ? "night" : "day",
    worker: String(row.worker == null ? "" : row.worker),
    role: row.role == null ? null : Number(row.role),
    policies: Number(row.policies) || 0,
    startedAt: String(row.startedAt || ""),
    endedAt: String(row.endedAt || ""),
  }));

  return summarizeShiftReport(rows, from, to, days, {
    dayStartMinutes,
    nightStartMinutes,
    gapMinutes,
  });
}

// Turn the per-(date, shift, worker) streak rows into the report shape: totals
// and averages per shift, per worker and per day.
function summarizeShiftReport(rows, from, to, days, settings) {
  const { dayStartMinutes, nightStartMinutes, gapMinutes } = settings;
  const dayRows = rows.filter((row) => row.shift === "day");
  const nightRows = rows.filter((row) => row.shift === "night");

  // Per worker: the day/night split plus the combined figures.
  const byWorker = new Map();
  for (const row of rows) {
    if (!byWorker.has(row.worker)) {
      byWorker.set(row.worker, {
        worker: row.worker,
        role: row.role,
        day: [],
        night: [],
      });
    }
    byWorker.get(row.worker)[row.shift].push(row);
  }

  const workers = [...byWorker.values()]
    .map((entry) => ({
      worker: entry.worker,
      role: entry.role,
      day: summarizeWorkerShift(entry.day, days),
      night: summarizeWorkerShift(entry.night, days),
      total: summarizeWorkerShift([...entry.day, ...entry.night], days),
    }))
    .sort(
      (a, b) =>
        b.total.policies - a.total.policies || a.worker.localeCompare(b.worker)
    );

  // Every day of the range, including the quiet ones, so a chart has no gaps.
  const daily = new Map();
  for (const row of rows) {
    if (!daily.has(row.date)) daily.set(row.date, { day: 0, night: 0 });
    daily.get(row.date)[row.shift] += row.policies;
  }
  const daysOut = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    const entry = daily.get(date) || { day: 0, night: 0 };
    daysOut.push({
      date,
      day: entry.day,
      night: entry.night,
      total: entry.day + entry.night,
    });
  }
  return {
    from,
    to,
    days,
    schedule: {
      day: {
        start: shiftTimeLabel(dayStartMinutes),
        end: shiftTimeLabel(nightStartMinutes),
        startMinutes: dayStartMinutes,
        endMinutes: nightStartMinutes,
        window: `${shiftTimeLabel(dayStartMinutes)}-${shiftTimeLabel(
          nightStartMinutes
        )}`,
      },
      night: {
        start: shiftTimeLabel(nightStartMinutes),
        end: shiftTimeLabel(dayStartMinutes),
        startMinutes: nightStartMinutes,
        endMinutes: dayStartMinutes,
        window: `${shiftTimeLabel(nightStartMinutes)}-${shiftTimeLabel(
          dayStartMinutes
        )}`,
      },
      // A pause longer than this between two insurances of the same employee
      // starts a new shift (the previous one ended at its last insurance).
      maxGapMinutes: gapMinutes,
    },
    summary: {
      day: summarizeShift(dayRows, days),
      night: summarizeShift(nightRows, days),
      overall: summarizeShift(rows, days),
    },
    workers,
    perDay: daysOut,
    rows,
  };
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
      const range = parseDateRange(req.query);
      if (range.error) {
        return res.status(400).json({ error: range.error });
      }
      const fromRaw = range.from;
      const toRaw = range.to;

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
      // walk-in net-value convention above (full price while active, the
      // annulment tax once annulled ONLY when the broker paid it, deleted
      // policies contribute nothing) and is keyed on the policy's creation date.
      // A charge the admin removed from a policy's broker history (a hidden
      // policy-derived row) is a void: the broker balance no longer charges it,
      // so it comes off here too, exactly like in the daily report.
      const [[brokerAgg]] = await DBConnection.query(
        `SELECT ROUND(SUM(CASE
                  WHEN i.Annulled = 0 THEN CAST(i.Price AS DECIMAL(15,2))
                  WHEN LOWER(TRIM(COALESCE(i.AnnulReason, ''))) = 'broker'
                  THEN COALESCE(i.AnnulFee, 0)
                  ELSE 0
                END) + COALESCE(SUM(v.Voided), 0), 2) AS Net
           FROM insurance i
           LEFT JOIN (
                 SELECT BrokerId AS VoidBrokerId, BlancNumber AS VoidBlanc,
                        SUM(Amount) AS Voided
                   FROM broker_balance_movements
                  WHERE Deleted = 1
                    AND Type IN ('policy', 'price_change', 'annulment',
                                 'deletion')
                  GROUP BY BrokerId, BlancNumber
               ) v
             ON v.VoidBrokerId = i.BrokerId AND v.VoidBlanc = i.BlancNumber
          WHERE i.BrokerId IS NOT NULL AND i.Deleted = 0
            AND i.CreationDate >= ? AND i.CreationDate < ?`,
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
  //                    (full price while active, the annulment tax once annulled
  //                    only when the broker paid it, nothing once deleted).
  //   amount         — cash actually received from the broker (a top-up taken
  //                    by a branch plus a hand-over paid to the owner, i.e.
  //                    "increase" and "handover" movements on the ledger).
  //   weeklyBalance  — totalOwed - amount (this cycle only, no leftover).
  //   leftover       — the balance carried over from previous cycles, expressed
  //                    as "owed": positive when the broker still owes, negative
  //                    when they overpaid.
  router.get("/reports/cash-inflow", auth, requireReportRole, async (req, res) => {
    try {
      const range = parseDateRange(req.query);
      if (range.error) {
        return res.status(400).json({ error: range.error });
      }
      const fromRaw = range.from;
      const toRaw = range.to;

      // Movements are keyed on the client's local wall-clock time; insurances
      // are keyed on their creation date (matching /reports/payments).
      const fromParam = fromRaw + " 00:00:00";
      const toParam = addOneDay(toRaw) + " 00:00:00";
      const fromDay = fromRaw;
      const toDay = addOneDay(toRaw);

      // 1) Cash inflow: money received from the broker within the period - a
      //    top-up taken by a branch ('increase') or a payment handed straight
      //    to the owner ('handover'). Both raise the broker's balance and are
      //    money the broker paid, so both settle what they owe.
      const [inflowRows] = await DBConnection.query(
        `SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS amount
           FROM broker_balance_movements
          WHERE Type IN ('increase', 'handover') AND Amount > 0 AND Deleted = 0
            AND CreatedAt >= ? AND CreatedAt < ?
          GROUP BY BrokerId`,
        [fromParam, toParam]
      );

      // 2) Total owed: net value of broker insurances created within the period.
      //    A charge the admin removed from a policy's broker history (a hidden
      //    policy-derived row) is a void: the broker balance no longer charges
      //    it, so it is not owed either.
      const [owedRows] = await DBConnection.query(
        `SELECT i.BrokerId AS brokerId,
                ROUND(SUM(CASE
                  WHEN i.Annulled = 0 THEN CAST(i.Price AS DECIMAL(15,2))
                  WHEN LOWER(TRIM(COALESCE(i.AnnulReason, ''))) = 'broker'
                  THEN COALESCE(i.AnnulFee, 0)
                  ELSE 0
                END) + COALESCE(SUM(v.Voided), 0), 2) AS totalOwed
           FROM insurance i
           LEFT JOIN (
                 SELECT BrokerId AS VoidBrokerId, BlancNumber AS VoidBlanc,
                        SUM(Amount) AS Voided
                   FROM broker_balance_movements
                  WHERE Deleted = 1
                    AND Type IN ('policy', 'price_change', 'annulment',
                                 'deletion')
                  GROUP BY BrokerId, BlancNumber
               ) v
             ON v.VoidBrokerId = i.BrokerId AND v.VoidBlanc = i.BlancNumber
          WHERE i.BrokerId IS NOT NULL AND i.Deleted = 0
            AND i.CreationDate >= ? AND i.CreationDate < ?
          GROUP BY i.BrokerId`,
        [fromDay, toDay]
      );

      // 3) Leftover: the ledger balance before the period start. The ledger is
      //    signed (negative = owes), so negate it to express "owed" (positive =
      //    still owes). Retired reduce/adjust rows are history only and are not
      //    part of the balance, so they are left out here too.
      const [leftoverRows] = await DBConnection.query(
        `SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS balanceBefore
           FROM broker_balance_movements
          WHERE Deleted = 0 AND CreatedAt < ?
            AND Type NOT IN ('reduce', 'adjust')
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

  // GET /reports/shifts — insurances created per shift per worker.
  //
  // Answers "how much did each worker write during each shift last week", with
  // the day and the night shift kept apart and the averages for each. There is
  // no shift table: each employee's policies are cut into STREAKS, where a
  // pause longer than `gap` minutes starts a new shift - so a shift ends at the
  // LAST insurance of the streak (around 07:30 / 19:30, but never exactly).
  // Each streak is labelled day or night by where most of its policies fall:
  //
  //   ?from=YYYY-MM-DD   first day of the range (inclusive)
  //   ?to=YYYY-MM-DD     last day of the range (inclusive)
  //   ?dayStart=07:30    start of the day shift (default 07:30)
  //   ?nightStart=19:30  start of the night shift (default 19:30); the two only
  //                      decide whether a streak counts as day or night
  //   ?gap=360           minutes without a new insurance that END a shift
  //                      (default 360 = 6 hours)
  //
  // A night streak that starts before the day shift belongs to the previous
  // date, so an after-midnight tail stays with the night it was worked.
  // Only insurances that still exist count (Deleted = 0); annulled ones are
  // still insurances that were created, so they stay in the count.
  router.get("/reports/shifts", auth, requireReportRole, async (req, res) => {
    try {
      const range = parseDateRange(req.query);
      if (range.error) {
        return res.status(400).json({ error: range.error });
      }
      const times = resolveShiftTimes(req.query);
      if (times.error) {
        return res.status(400).json({ error: times.error });
      }

      const report = await buildShiftReport(DBConnection, {
        from: range.from,
        to: range.to,
        dayStartMinutes: times.dayStartMinutes,
        nightStartMinutes: times.nightStartMinutes,
        gapMinutes: times.gapMinutes,
      });
      res.json(report);
    } catch (err) {
      console.error("Reports shift lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch shift report" });
    }
  });

  return router;
};

// The CLI (`db/shift-report.js`) renders the very same report, so both the API
// and the terminal answer with identical figures.
module.exports.buildShiftReport = buildShiftReport;
module.exports.parseShiftTime = parseShiftTime;
module.exports.DEFAULT_DAY_START = DEFAULT_DAY_START;
module.exports.DEFAULT_NIGHT_START = DEFAULT_NIGHT_START;
module.exports.DEFAULT_MAX_GAP_MINUTES = DEFAULT_MAX_GAP_MINUTES;

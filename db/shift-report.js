"use strict";
// Read-only "insurances created per shift per worker" report: how many policies
// every worker wrote during each day shift and each night shift of a period,
// plus the averages per shift, per worker and per day.
//
// Run from the repo root:
//   node --env-file=.env db/shift-report.js
//   node --env-file=.env db/shift-report.js --from=2026-11-21 --to=2026-11-27
//   node --env-file=.env db/shift-report.js --days=14
//   node --env-file=.env db/shift-report.js --from=2026-11-21 --to=2026-11-27 --day-start=07:30 --night-start=19:30
//   node --env-file=.env db/shift-report.js --json          (raw JSON, for piping)
//   node --env-file=.env db/shift-report.js --live          (LIVE_DB_* target)
//
// There is no shift table: a shift is a fixed window of the day, taken from the
// policy's CreationDate. The day shift runs from --day-start (07:30 by default)
// up to --night-start (19:30), the night shift is the rest of the day, so it
// spans midnight. Half hours are fine. The part after midnight keeps the date
// the shift STARTED: a policy written at 03:00 on the 22nd is the night shift of
// the 21st - the way the crossing works its shifts, and the way "End shift"
// closes the drawer.
//
// Without --from/--to the report covers the last --days=N complete days (7 by
// default), i.e. it ends YESTERDAY: today's shift is still open, so counting it
// would always show a half-finished day.
//
// Only insurances that still exist count (Deleted = 0). An annulled policy was
// still written, so it stays in the count. Nothing is written; the script reads
// `insurance` and `users` only, so it is safe against the live database.

const mysql = require("mysql2/promise");
const { databaseSettings } = require("./repair-broker-ledger.js");
const reports = require("../Requests/Reports.js");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, "0");

// Local wall-clock date of this machine, the same clock CreationDate uses.
function localYmd(date) {
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate())
  );
}

// Add a number of days to a "YYYY-MM-DD" string (UTC arithmetic).
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const stamp = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return (
    stamp.getUTCFullYear() +
    "-" +
    pad(stamp.getUTCMonth() + 1) +
    "-" +
    pad(stamp.getUTCDate())
  );
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const text = (value, width) => String(value == null ? "" : value).padEnd(width);
const count = (value, width) => String(value).padStart(width);
const rate = (value, width) => Number(value || 0).toFixed(2).padStart(width);

// The detected span of one shift, from its first to its last insurance:
// "07:41-19:18", or "19:41-07:12+1" when it runs past midnight.
function spanLabel(row) {
  const start = String(row.startedAt || "");
  const end = String(row.endedAt || "");
  if (start.length < 16 || end.length < 16) return "";
  const nextDay = end.slice(0, 10) !== start.slice(0, 10);
  return `${start.slice(11, 16)}-${end.slice(11, 16)}${nextDay ? "+1" : ""}`;
}

function printRows(title, rows) {
  console.log(`\n${title}`);
  console.log(
    "  " +
      text("date", 12) +
      text("worker", 24) +
      count("role", 5) +
      "  " +
      text("shift", 12) +
      count("policies", 10)
  );
  let total = 0;
  for (const row of rows) {
    total += row.policies;
    console.log(
      "  " +
        text(row.date, 12) +
        text(row.worker, 24) +
        count(row.role == null ? "-" : row.role, 5) +
        "  " +
        text(spanLabel(row), 12) +
        count(row.policies, 10)
    );
  }
  if (!rows.length) {
    console.log("  (no insurance was created in this shift)");
  }
  console.log("  " + text("TOTAL", 55) + count(total, 10));
}

function printAverages(summary) {
  console.log("\nAVERAGES");
  console.log(
    "  " +
      text("shift", 7) +
      count("policies", 10) +
      count("workers", 9) +
      count("worker-shifts", 15) +
      count("per shift", 11) +
      count("per worker", 12) +
      count("per day", 9) +
      count("per worker-day", 16)
  );
  for (const key of ["day", "night", "overall"]) {
    const bucket = summary[key];
    if (!bucket) continue;
    console.log(
      "  " +
        text(key, 7) +
        count(bucket.policies, 10) +
        count(bucket.workers, 9) +
        count(bucket.shifts, 15) +
        rate(bucket.avgPoliciesPerShift, 11) +
        rate(bucket.avgPoliciesPerWorker, 12) +
        rate(bucket.avgPoliciesPerDay, 9) +
        rate(bucket.avgPoliciesPerWorkerPerDay, 16)
    );
  }
}


function printWorkers(workers) {
  console.log("\nPER WORKER");
  console.log(
    "  " +
      text("worker", 24) +
      count("role", 5) +
      count("day", 7) +
      count("night", 7) +
      count("total", 7) +
      count("avg/shift", 11) +
      count("avg/day", 9)
  );
  for (const worker of workers) {
    console.log(
      "  " +
        text(worker.worker, 24) +
        count(worker.role == null ? "-" : worker.role, 5) +
        count(worker.day.policies, 7) +
        count(worker.night.policies, 7) +
        count(worker.total.policies, 7) +
        rate(worker.total.avgPoliciesPerShift, 11) +
        rate(worker.total.avgPoliciesPerDay, 9)
    );
  }
  if (!workers.length) {
    console.log("  (no worker created an insurance in the range)");
  }
}

function printReport(report, target) {
  console.log(
    `\nInsurances created per shift per worker - ${report.from} .. ${report.to} ` +
      `(${report.days} day${report.days === 1 ? "" : "s"})`
  );
  console.log(
    `  database  ${target.live ? "LIVE" : "local"} ` +
      `${target.user}@${target.host}:${target.port}/${target.database}`
  );
  console.log(
    `  shifts    day ${report.schedule.day.window}, ` +
      `night ${report.schedule.night.window}, a shift ends after ` +
      `${report.schedule.maxGapMinutes} min without a new insurance`
  );

  printRows(
    `DAY SHIFT (${report.schedule.day.window})`,
    report.rows.filter((row) => row.shift === "day")
  );
  printRows(
    `NIGHT SHIFT (${report.schedule.night.window})`,
    report.rows.filter((row) => row.shift === "night")
  );
  printAverages(report.summary);
  printWorkers(report.workers);

  console.log(
    "\nA shift is a streak of one employee's insurances: it ends at the last " +
      "insurance before a pause longer than the one above, which is why the " +
      "end time is near 07:30 / 19:30 but never exact."
  );
  console.log(
    "A streak is day or night by where most of its policies fall; a night " +
      "that starts before the day shift is dated the previous day."
  );
  console.log(
    "Averages: per shift = policies / a worker's shifts, per worker-day = " +
      "policies / (workers x days of the range)."
  );
}


async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node --env-file=.env db/shift-report.js " +
        "[--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--days=N] " +
        "[--day-start=HH:MM] [--night-start=HH:MM] [--gap=MINUTES] " +
        "[--live] [--json]"
    );
    return;
  }

  const daysArg = argValue(args, "days");
  const days = daysArg === null ? 7 : Number(daysArg);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("--days must be a whole number between 1 and 366");
  }

  const fromArg = argValue(args, "from");
  const toArg = argValue(args, "to");
  if (fromArg !== null && !DATE_RE.test(fromArg)) {
    throw new Error("--from must be a YYYY-MM-DD date");
  }
  if (toArg !== null && !DATE_RE.test(toArg)) {
    throw new Error("--to must be a YYYY-MM-DD date");
  }

  // Default window: the last `days` COMPLETE days, ending yesterday.
  const yesterday = addDays(localYmd(new Date()), -1);
  const to = toArg || yesterday;
  const from = fromArg || addDays(to, -(days - 1));
  if (from > to) {
    throw new Error("--from must be on or before --to");
  }

  const dayStartArg = argValue(args, "day-start");
  const nightStartArg = argValue(args, "night-start");
  const dayStart = dayStartArg === null ? reports.DEFAULT_DAY_START : dayStartArg;
  const nightStart =
    nightStartArg === null ? reports.DEFAULT_NIGHT_START : nightStartArg;
  const dayStartMinutes = reports.parseShiftTime(dayStart);
  const nightStartMinutes = reports.parseShiftTime(nightStart);
  if (
    dayStartMinutes === null ||
    nightStartMinutes === null ||
    nightStartMinutes <= dayStartMinutes
  ) {
    throw new Error(
      "--day-start/--night-start are times of day (HH:MM) and the night shift " +
        "must start after the day shift, e.g. --day-start=07:30 --night-start=19:30"
    );
  }

  // How long a pause between two insurances ends the shift (and the next one
  // starts). Exposed because a quiet stretch at one crossing is not the same as
  // at another; 6 hours is the default.
  const gapArg = argValue(args, "gap");
  const gapMinutes =
    gapArg === null ? reports.DEFAULT_MAX_GAP_MINUTES : Number(gapArg);
  if (!Number.isInteger(gapMinutes) || gapMinutes < 15 || gapMinutes > 1440) {
    throw new Error("--gap must be a whole number of minutes between 15 and 1440");
  }

  const target = databaseSettings(args);
  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    dateStrings: true,
  });

  try {
    const report = await reports.buildShiftReport(conn, {
      from,
      to,
      dayStartMinutes,
      nightStartMinutes,
      gapMinutes,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report, target);
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Shift report failed:", err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { main, printReport, localYmd, addDays };


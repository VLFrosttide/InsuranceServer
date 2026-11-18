"use strict";
// The bi-weekly billing run.
//
// Every two weeks (Requests/PaymentSchedule.js) the balance of the period that
// just ended is recorded:
//
//   1. every broker with policies in the period gets one bill
//      (db/brokerBills.js) - the policies counted by vehicle type and summed,
//      annulled ones at their annulled price;
//   2. the bill's Excel file is mailed to every address of that broker
//      (Mail/brokerBillMail.js), and the bill remembers when and to whom.
//
// The run is idempotent: closing a period twice finds the bills already stored,
// and a failed mail is retried on the next tick (up to BILL_MAX_MAIL_ATTEMPTS
// times) instead of being lost. Bills that still have no address or failed
// every attempt keep their error, which the client shows on the broker.
//
// What is never done automatically is billing the PAST: the first run stores an
// "auto start" period (app_settings.billing_auto_start, or BILLING_AUTO_START)
// and no period starting before it is closed on its own. An admin can still
// close an older period by hand from the client (POST /brokers/bills/close).

const {
  getSchedule,
  lastClosedPeriod,
} = require("../Requests/PaymentSchedule.js");
const bills = require("../db/brokerBills.js");
const { sendBillMail } = require("./brokerBillMail.js");

const AUTO_START_SETTING = "billing_auto_start";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// How often the run looks at the clock. A quarter of an hour is plenty: a bill
// only has to go out sometime after the period ends.
const CHECK_INTERVAL_MS =
  Number(process.env.BILLING_CHECK_INTERVAL_MS) || 15 * 60 * 1000;

// How many times one bill may be mailed before it is left alone with its error.
const MAX_MAIL_ATTEMPTS = Number(process.env.BILL_MAX_MAIL_ATTEMPTS) || 3;

let db = null;
let lastTick = null;

function setDb(DBConnection) {
  db = DBConnection;
}
module.exports.setDb = setDb;

function isEnabled() {
  return String(process.env.BILLING_ENABLED ?? "0").trim() === "1";
}
module.exports.isEnabled = isEnabled;

/**
 * The first period the automatic run may close. Stored once, so a deployment
 * never bills history: the first tick records the CURRENT period's start and
 * only later periods are closed by the scheduler. BILLING_AUTO_START
 * ("YYYY-MM-DD") overrides it.
 *
 * @param {{query: Function}} conn
 * @param {Date} [now]
 * @returns {Promise<string>} "YYYY-MM-DD"
 */
async function autoStartPeriod(conn, now = new Date()) {
  const configured = String(process.env.BILLING_AUTO_START || "").trim();
  if (DATE_RE.test(configured)) return configured;
  const current = getSchedule(now).periodStart;

  try {
    const [rows] = await conn.query(
      "SELECT value FROM app_settings WHERE name = ?",
      [AUTO_START_SETTING]
    );
    const stored = rows && rows[0] && String(rows[0].value || "").slice(0, 10);
    if (DATE_RE.test(stored)) return stored;
    await conn.query(
      `INSERT INTO app_settings (name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [AUTO_START_SETTING, current]
    );
  } catch (err) {
    // A database without app_settings (minimal setup) still bills - it just
    // falls back to "from this period on", which is the safe default.
  }
  return current;
}
module.exports.autoStartPeriod = autoStartPeriod;

/**
 * Mail every bill that has not reached its broker yet.
 *
 * @param {{query: Function}} conn
 * @param {{gmail?: object}} [options]  Injectable sender, for the tests.
 * @returns {Promise<{sent: object[], failed: object[]}>}
 */
async function sendPendingBills(conn, options = {}) {
  const pending = await bills.loadBillsToMail(conn, MAX_MAIL_ATTEMPTS);
  const sent = [];
  const failed = [];

  for (const entry of pending) {
    // A sub-broker is never mailed: without a main broker there is nobody to
    // bill, so the bill keeps that error and waits for the mapping to be fixed.
    if (entry.subWithoutParent) {
      const error = "sub-broker has no main broker to send the bill to";
      await bills.markBillMailFailed(conn, entry.bill.id, error);
      failed.push({
        billId: entry.bill.id,
        brokerId: entry.bill.brokerId,
        brokerName: entry.brokerName,
        error,
      });
      continue;
    }

    // The rows are re-priced the way the bill charges them (a sub-broker's
    // display price, a main broker's stored price).
    const lines = await bills.loadBillDocumentLines(conn, entry.bill);
    const result = await sendBillMail({
      bill: entry.bill,
      brokerName: entry.brokerName,
      recipientName: entry.recipientName,
      brokerCode: entry.brokerCode,
      emails: entry.emails,
      lines,
      gmail: options.gmail,
    });

    if (result.sent) {
      await bills.markBillEmailed(conn, entry.bill.id, {
        emails: entry.emails,
      });
      sent.push({
        billId: entry.bill.id,
        brokerId: entry.bill.brokerId,
        brokerName: entry.brokerName,
        emails: entry.emails,
        sub: Boolean(entry.isSub),
      });
    } else {
      await bills.markBillMailFailed(conn, entry.bill.id, result.error);
      failed.push({
        billId: entry.bill.id,
        brokerId: entry.bill.brokerId,
        brokerName: entry.brokerName,
        error: result.error,
      });
    }
  }

  return { sent, failed };
}
module.exports.sendPendingBills = sendPendingBills;

/**
 * Close a period by hand and mail its bills (the admin action in the client).
 *
 * @param {{query: Function}} conn
 * @param {string} periodStart  "YYYY-MM-DD"
 * @param {{gmail?: object}} [options]
 * @returns {Promise<object>}
 */
async function closePeriodNow(conn, periodStart, options = {}) {
  const period = bills.periodFor(periodStart);
  const closed = await bills.closePeriod(
    conn,
    period.periodStart,
    period.periodEnd
  );
  const mailed = await sendPendingBills(conn, options);
  return { period, closed, mailed };
}
module.exports.closePeriodNow = closePeriodNow;

/**
 * One billing tick: close the period that just ended (unless it is already
 * closed or older than the auto-start period) and mail every bill still
 * waiting.
 *
 * @param {Date} [now]
 * @param {{gmail?: object}} [options]  Injectable sender, for the tests.
 * @returns {Promise<object>} What the tick did.
 */
async function runBillingTick(now = new Date(), options = {}) {
  lastTick = now;
  if (!db) return { period: null, skipped: "no database" };
  if (!isEnabled()) return { period: null, skipped: "billing disabled" };

  const period = lastClosedPeriod(now);
  const floor = await autoStartPeriod(db, now);
  let closed = null;

  if (period.periodStart < floor) {
    closed = { skipped: "period is before the automatic start", floor };
  } else {
    const [[existing]] = await db.query(
      "SELECT COUNT(*) AS n FROM broker_bills WHERE PeriodStart = ?",
      [period.periodStart]
    );
    if (Number(existing && existing.n) > 0) {
      closed = { skipped: "period already closed" };
    } else {
      closed = await bills.closePeriod(db, period.periodStart, period.periodEnd);
    }
  }

  const mailed = await sendPendingBills(db, options);
  return { period, closed, mailed };
}
module.exports.runBillingTick = runBillingTick;

/**
 * Start the bi-weekly run: an immediate tick (the server may come up right
 * after a period ended) and then one every CHECK_INTERVAL_MS.
 */
function startBillingScheduler() {
  const tick = () => {
    runBillingTick().catch((err) =>
      console.error(
        "Broker billing run failed:",
        err && err.message ? err.message : err
      )
    );
  };
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  tick();
}
module.exports.startBillingScheduler = startBillingScheduler;

module.exports.MAX_MAIL_ATTEMPTS = MAX_MAIL_ATTEMPTS;
module.exports.CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;
module.exports.lastTick = () => lastTick;


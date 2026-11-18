"use strict";
// Payment schedule for broker balances.
//
// Payments settle every two weeks. The last few days before each cutoff are
// the payment window (the "weekend" grace period); if a broker's balance is
// still negative on the cutoff day, they are cut off and their insurances are
// no longer created until the balance is paid off.
//
// The schedule is anchored to a known cutoff day and repeats every
// PAYMENT_PERIOD_DAYS. Override the anchor with env PAYMENT_ANCHOR
// (YYYY-MM-DD) if the settlement dates change.

const DAY_MS = 86400000;
const PAYMENT_PERIOD_DAYS = 14;
const PAYMENT_GRACE_DAYS = 3;

function parseAnchor() {
  const raw = (process.env.PAYMENT_ANCHOR || "2026-10-19").trim();
  const [y, m, d] = raw.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid PAYMENT_ANCHOR: ${raw}`);
  return Date.UTC(y, m - 1, d);
}

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// Shift a "YYYY-MM-DD" date by a number of calendar days (UTC arithmetic, so
// daylight-saving changes can never make a period one day shorter).
function shiftDays(ymd, days) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const step = Number(days);
  const day = Number.isFinite(step) ? d + step : d;
  return new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10);
}

// The next cutoff date on or after `now`.
function nextCutoff(now) {
  const t = (toDateOnly(now) || new Date()).getTime();
  const anchor = parseAnchor();
  const k = Math.ceil((t - anchor) / (PAYMENT_PERIOD_DAYS * DAY_MS));
  return new Date(anchor + k * PAYMENT_PERIOD_DAYS * DAY_MS);
}

/**
 * The current payment schedule.
 *
 * @param {Date|string} [now]
 * @returns {{periodStart: string, periodEnd: string, cutoff: string,
 *            windowStart: string, windowEnd: string,
 *            periodLengthDays: number, graceDays: number}}
 */
function getSchedule(now = new Date()) {
  const cutoff = nextCutoff(now);
  const periodStart = new Date(cutoff.getTime() - PAYMENT_PERIOD_DAYS * DAY_MS);
  const windowStart = new Date(cutoff.getTime() - PAYMENT_GRACE_DAYS * DAY_MS);
  const windowEnd = new Date(cutoff.getTime() - 1 * DAY_MS);

  return {
    periodStart: fmt(periodStart),
    periodEnd: fmt(windowEnd),
    cutoff: fmt(cutoff),
    windowStart: fmt(windowStart),
    windowEnd: fmt(windowEnd),
    periodLengthDays: PAYMENT_PERIOD_DAYS,
    graceDays: PAYMENT_GRACE_DAYS,
  };
}

/**
 * The two-week period that a given day belongs to (inclusive last day), plus
 * the cutoff that closes it.
 *
 * @param {string} periodStart  First day of the period ("YYYY-MM-DD").
 * @returns {{periodStart: string, periodEnd: string, cutoff: string}}
 */
function periodFor(periodStart) {
  return {
    periodStart,
    periodEnd: shiftDays(periodStart, PAYMENT_PERIOD_DAYS - 1),
    cutoff: shiftDays(periodStart, PAYMENT_PERIOD_DAYS),
  };
}

/**
 * The period that has just been closed: the one before the current period.
 *
 * @param {Date} [now]
 * @returns {{periodStart: string, periodEnd: string, cutoff: string}}
 */
function previousPeriod(now = new Date()) {
  const current = getSchedule(now);
  const start = shiftDays(current.periodStart, -PAYMENT_PERIOD_DAYS);
  return {
    periodStart: start,
    periodEnd: shiftDays(current.periodStart, -1),
    cutoff: current.periodStart,
  };
}

/**
 * The period whose two weeks are over and can therefore be billed.
 *
 * On the cutoff day itself `getSchedule` still reports the period that ends the
 * day before (its cutoff), so that period is the one that just closed. On any
 * other day it is the period before the current one. Examples with the default
 * anchor: on 2026-11-29 -> 2026-11-02..2026-11-15; on 2026-11-30 (cutoff) ->
 * 2026-11-16..2026-11-29; on 2026-12-01 -> 2026-11-16..2026-11-29 again.
 *
 * @param {Date|string} [now]
 * @returns {{periodStart: string, periodEnd: string, cutoff: string}}
 */
function lastClosedPeriod(now = new Date()) {
  const current = getSchedule(now);
  const d = now instanceof Date ? now : new Date(now);
  const valid = Number.isFinite(d.getTime()) ? d : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const today = `${valid.getFullYear()}-${p(valid.getMonth() + 1)}-${p(
    valid.getDate()
  )}`;
  if (today >= current.cutoff) {
    return {
      periodStart: current.periodStart,
      periodEnd: current.windowEnd,
      cutoff: current.cutoff,
    };
  }
  return previousPeriod(valid);
}

/**
 * The first day of the payment period a given day belongs to.
 *
 * The bill window is [periodStart, cutoff): a policy created ON a cutoff day
 * already belongs to the NEXT period (that is the day the new period starts).
 *
 * @param {Date|string} value
 * @returns {string|null} "YYYY-MM-DD"
 */
function periodStartFor(value) {
  const d = toDateOnly(value);
  if (!d) return null;
  const day = fmt(d);
  const cutoff = fmt(nextCutoff(d));
  if (day >= cutoff) return cutoff;
  return shiftDays(cutoff, -PAYMENT_PERIOD_DAYS);
}

module.exports = {
  getSchedule,
  nextCutoff,
  periodFor,
  previousPeriod,
  lastClosedPeriod,
  periodStartFor,
  shiftDays,
  PAYMENT_PERIOD_DAYS,
  PAYMENT_GRACE_DAYS,
  DAY_MS,
};

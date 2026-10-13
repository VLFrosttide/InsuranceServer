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

module.exports = {
  getSchedule,
  nextCutoff,
  PAYMENT_PERIOD_DAYS,
  PAYMENT_GRACE_DAYS,
  DAY_MS,
};

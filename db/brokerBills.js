"use strict";
// Bi-weekly broker bills: what a broker owes for one payment period.
//
// A bill covers ONE payment period of Requests/PaymentSchedule.js (two weeks,
// e.g. 2026-11-16 .. 2026-11-29) and is recorded once the period is over - the
// balance of the period is struck at its end (cutoff = the day after PeriodEnd).
// It holds every insurance created for that broker inside the period:
//
//   * an active policy counts with its Price;
//   * an annulled policy counts with its ANNULLED price (AnnulFee - the part of
//     the price the company keeps), never with the original sale price (kept in
//     OriginalPrice once the tax becomes the price);
//   * a deleted policy does not count at all.
//
// Two things are added to the period's charges:
//
//   * REFUNDS. A policy that was already billed and PAID in an earlier period
//     and is annulled now gives the broker back the remaining cash
//     (OriginalPrice - AnnulFee; older rows without OriginalPrice use Price).
//     That money is a credit on the current period, so the
//     bill shows it as its own section and the amount due is
//     `Charges - Refund`. (The broker's balance is credited by the annulment
//     itself - see Requests/Brokers.js - the bill only reports it.)
//   * SUB-BROKERS. A sub-broker is charged its display price (its own
//     broker_tariffs, set by the main broker) while the main broker pays us the
//     stored Price, so the bill also carries CostToUs (what the main broker pays
//     us) and Profit (charged - cost). Sub-brokers are never mailed: the main
//     broker gets the bill instead (ParentBrokerId).
//
// Bills are in EUROS ONLY: the broker business runs in EUR, so every amount is
// summed as EUR and the currency of a bill is always "EUR".
//
// The policies are counted by vehicle type (insurance.Otomobil: Automobile,
// Motor, Bus, Trailer) and summed, which is what the broker's Excel file and
// the email show. The amount rule is the one Requests/Reports.js (cash-inflow)
// and the website's policy export already use, so a bill always matches the
// brokers report of the same period.
//
// Bills are stored in `broker_bills`, one row per broker and period
// (UNIQUE (BrokerId, PeriodStart)), so closing a period twice is harmless: the
// second run finds the bills already there and only mails the missing ones.
//
// Paying a bill is NOT done here: it writes a broker balance movement, which
// belongs to the request handlers (Requests/BrokerBills.js) next to every other
// balance change. This module only tags the bill itself as paid.

const {
  periodFor,
  previousPeriod,
  periodStartFor,
  shiftDays,
} = require("../Requests/PaymentSchedule.js");
const { isSubBrokerName } = require("./BrokerInfo.js");

const BILL_TABLE_SQL = `CREATE TABLE IF NOT EXISTS broker_bills (
  id INT NOT NULL AUTO_INCREMENT,
  BrokerId INT NOT NULL,
  PeriodStart DATE NOT NULL,
  PeriodEnd DATE NOT NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  Charges DECIMAL(15,2) NOT NULL DEFAULT 0,
  Refund DECIMAL(15,2) NOT NULL DEFAULT 0,
  Amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  PolicyCount INT NOT NULL DEFAULT 0,
  AnnulledCount INT NOT NULL DEFAULT 0,
  CarriedOver DECIMAL(15,2) NOT NULL DEFAULT 0,
  CostToUs DECIMAL(15,2) NULL,
  Profit DECIMAL(15,2) NULL,
  ParentBrokerId INT NULL,
  Status VARCHAR(20) NOT NULL DEFAULT 'open',
  Breakdown LONGTEXT NULL,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  EmailedAt DATETIME NULL,
  Emails VARCHAR(1000) NOT NULL DEFAULT '',
  MailAttempts INT NOT NULL DEFAULT 0,
  MailError VARCHAR(255) NOT NULL DEFAULT '',
  PaidAt DATETIME NULL,
  PaidBy VARCHAR(45) NULL,
  PaymentType VARCHAR(20) NULL,
  PaymentCurrency VARCHAR(3) NULL,
  Branch VARCHAR(45) NULL,
  OriginalAmount DECIMAL(15,2) NULL,
  AdjustReason VARCHAR(255) NOT NULL DEFAULT '',
  AdjustedBy VARCHAR(45) NULL,
  AdjustedAt DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_broker_bill (BrokerId, PeriodStart),
  KEY idx_broker_bills_broker (BrokerId, PeriodStart),
  KEY idx_broker_bills_status (Status, PeriodStart)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Bi-weekly broker bills (one row per broker and payment period)'`;
module.exports.BILL_TABLE_SQL = BILL_TABLE_SQL;

// Columns added after the first version of the table. A deployment that already
// created `broker_bills` gets them on the next start-up; an existing column is
// an error the database reports and that is simply ignored here.
const BILL_EXTRA_COLUMNS = [
  ["Charges", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
  ["Refund", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
  ["CostToUs", "DECIMAL(15,2) NULL"],
  ["Profit", "DECIMAL(15,2) NULL"],
  ["ParentBrokerId", "INT NULL"],
  ["OriginalAmount", "DECIMAL(15,2) NULL"],
  ["AdjustReason", "VARCHAR(255) NOT NULL DEFAULT ''"],
  ["AdjustedBy", "VARCHAR(45) NULL"],
  ["AdjustedAt", "DATETIME NULL"],
];
module.exports.BILL_EXTRA_COLUMNS = BILL_EXTRA_COLUMNS;

// Which connections already have the table. A WeakMap so a test (or a second
// pool) never reuses another connection's answer.
const readyTables = new WeakMap();

/**
 * Create `broker_bills` on first use (and add the columns a deployment created
 * before them is missing), so the server also works on a database that has not
 * been set up again after the update.
 *
 * @param {{query: Function}} conn
 * @returns {Promise<void>}
 */
async function ensureBillTable(conn) {
  const cached = readyTables.get(conn);
  if (cached) return cached;
  const ready = (async () => {
    await conn.query(BILL_TABLE_SQL);
    for (const [name, definition] of BILL_EXTRA_COLUMNS) {
      try {
        await conn.query(
          `ALTER TABLE broker_bills ADD COLUMN ${name} ${definition}`
        );
      } catch {
        // The column is already there.
      }
    }
  })().catch((err) => {
    readyTables.delete(conn);
    throw err;
  });
  readyTables.set(conn, ready);
  return ready;
}
module.exports.ensureBillTable = ensureBillTable;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
module.exports.round2 = round2;

// Local wall-clock "YYYY-MM-DD HH:MM:SS", the format every other ledger row of
// the database is stamped with (see CurrentCash.clientLocalDateTime).
function nowLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  );
}
module.exports.nowLocal = nowLocal;

const isDate = (value) =>
  Object.prototype.toString.call(value) === "[object Date]" &&
  Number.isFinite(value.getTime());

// A DATE column as "YYYY-MM-DD" (""), no matter what mysql2 returned.
function dateOnly(value) {
  if (!value) return "";
  if (isDate(value)) {
    const p = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(
      value.getDate()
    )}`;
  }
  return String(value).slice(0, 10);
}
module.exports.dateOnly = dateOnly;

// A DATE/DATETIME column as "YYYY-MM-DD HH:MM:SS" ("").
function dateTimeOnly(value) {
  if (!value) return "";
  if (isDate(value)) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ` +
      `${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`
    );
  }
  return String(value).slice(0, 19);
}
module.exports.dateTimeOnly = dateTimeOnly;

/**
 * The amount one policy contributes to a bill: its price while active, its
 * annulled price (the fee kept when it was annulled) once annulled.
 *
 * @param {{Price?: any, AnnulFee?: any, Annulled?: any}} row
 * @returns {number}
 */
function policyAmount(row) {
  const annulled = Number(row && row.Annulled) === 1;
  const raw = annulled ? row && row.AnnulFee : row && row.Price;
  if (raw === null || raw === undefined || String(raw).trim() === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(n) : 0;
}
module.exports.policyAmount = policyAmount;

// Vehicle type of a policy ("Automobile", "Motor", "Bus", "Trailer", or what
// ever the form stored; "" when the row has none).
function policyType(row) {
  return String((row && row.Otomobil) ?? "").trim();
}
module.exports.policyType = policyType;

/**
 * One bill line (a policy of the period) in the shape the Excel file, the email
 * and the API use.
 *
 * @param {object} row  An `insurance` row (see loadBillLines).
 * @returns {{policyNumber: string, blancNumber: string, carNumber: string,
 *            type: string, duration: number, currency: string,
 *            creationDate: string, annulled: boolean, amount: number}}
 */
function toBillLine(row) {
  return {
    policyNumber: String(row.PolicyNumber ?? "").trim(),
    blancNumber: String(row.BlancNumber ?? "").trim(),
    carNumber: String(row.CarNumber ?? "").trim(),
    type: policyType(row),
    duration: Number(row.Duration) || 0,
    currency: String(row.CurrencyType ?? "").trim() || "EUR",
    creationDate: dateTimeOnly(row.CreationDate),
    annulled: Number(row.Annulled) === 1,
    amount: policyAmount(row),
  };
}
module.exports.toBillLine = toBillLine;

/**
 * Count and sum bill lines by vehicle type (and, for reference, by currency).
 *
 * @param {Array<object>} lines  Bill lines (see toBillLine).
 * @returns {{policies: number, annulled: number, total: number,
 *            byType: Array<{type: string, count: number, annulled: number, sum: number}>,
 *            byCurrency: Array<{currency: string, count: number, sum: number}>}}
 */
function summarizeLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const types = new Map();
  const currencies = new Map();
  let total = 0;
  let annulled = 0;

  for (const line of list) {
    const amount = round2(line.amount);
    total += amount;
    if (line.annulled) annulled += 1;

    const type = String(line.type ?? "").trim();
    if (!types.has(type)) {
      types.set(type, { type, count: 0, annulled: 0, sum: 0 });
    }
    const bucket = types.get(type);
    bucket.count += 1;
    bucket.sum = round2(bucket.sum + amount);
    if (line.annulled) bucket.annulled += 1;

    const currency = String(line.currency ?? "").trim() || "EUR";
    if (!currencies.has(currency)) {
      currencies.set(currency, { currency, count: 0, sum: 0 });
    }
    const money = currencies.get(currency);
    money.count += 1;
    money.sum = round2(money.sum + amount);
  }

  // Named types first (alphabetically), the "no type" bucket last.
  const byType = Array.from(types.values()).sort((a, b) => {
    if (a.type === b.type) return 0;
    if (!a.type) return 1;
    if (!b.type) return -1;
    return a.type.localeCompare(b.type);
  });
  const byCurrency = Array.from(currencies.values()).sort((a, b) =>
    a.currency.localeCompare(b.currency)
  );

  return {
    policies: list.length,
    annulled,
    total: round2(total),
    byType,
    byCurrency,
  };
}
module.exports.summarizeLines = summarizeLines;


/**
 * Every non-deleted insurance of one broker created inside a period.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {string} periodStart  "YYYY-MM-DD"
 * @param {string} periodEnd    "YYYY-MM-DD" (inclusive)
 * @returns {Promise<object[]>} Raw `insurance` rows, oldest first.
 */
async function loadBillLines(conn, brokerId, periodStart, periodEnd) {
  const [rows] = await conn.query(
    `SELECT PolicyNumber, BlancNumber, CarNumber, Otomobil, Duration, Price,
            OriginalPrice, CurrencyType, CreationDate, Annulled, AnnulFee,
            AnnulReason, NonTurk
       FROM insurance
      WHERE BrokerId = ? AND Deleted = 0
        AND CreationDate >= ? AND CreationDate < ?
      ORDER BY CreationDate, BlancNumber`,
    [
      brokerId,
      `${periodStart} 00:00:00`,
      `${shiftDays(periodEnd, 1)} 00:00:00`,
    ]
  );
  return rows || [];
}
module.exports.loadBillLines = loadBillLines;

/**
 * The policies of a broker annulled INSIDE a period (whatever period they were
 * created in). The caller keeps the ones whose own period was already billed
 * and paid - those are the refunds the current period carries.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {Promise<object[]>} Raw `insurance` rows, oldest annulment first.
 */
async function loadAnnulments(conn, brokerId, periodStart, periodEnd) {
  const [rows] = await conn.query(
    `SELECT PolicyNumber, BlancNumber, CarNumber, Otomobil, Duration, Price,
            OriginalPrice, CurrencyType, CreationDate, AnnulDate, Annulled,
            AnnulFee, AnnulReason, NonTurk
       FROM insurance
      WHERE BrokerId = ? AND Deleted = 0 AND Annulled = 1
        AND AnnulDate >= ? AND AnnulDate < ?
      ORDER BY AnnulDate, BlancNumber`,
    [
      brokerId,
      `${periodStart} 00:00:00`,
      `${shiftDays(periodEnd, 1)} 00:00:00`,
    ]
  );
  return rows || [];
}
module.exports.loadAnnulments = loadAnnulments;

/**
 * The broker's balance (signed) right before a period starts, from the balance
 * ledger. Informational on the bill: a negative value is money carried over
 * from earlier periods.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {string} periodStart
 * @returns {Promise<number>}
 */
async function loadOpeningBalance(conn, brokerId, periodStart) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(Amount), 0) AS balance
       FROM broker_balance_movements
      WHERE BrokerId = ? AND Deleted = 0 AND CreatedAt < ?`,
    [brokerId, `${periodStart} 00:00:00`]
  );
  return round2(row && row.balance);
}
module.exports.loadOpeningBalance = loadOpeningBalance;

// The sub-broker helpers live in Requests/Brokers.js (the single place that
// knows how a sub-broker's display price is derived). Required lazily so this
// model can be loaded on its own.
let subHelpers = null;
function subBrokerHelpers() {
  if (!subHelpers) {
    const brokers = require("../Requests/Brokers.js");
    subHelpers = {
      displayData: brokers.computeSubBrokerDisplayData,
      priceFor: brokers.computePolicyTariffPrice,
    };
  }
  return subHelpers;
}

/**
 * A policy of the period as the BILL charges it to this broker.
 *
 * A main broker is charged the stored price (`toBillLine` already did that). A
 * sub-broker is charged its display price (its own `broker_tariffs`, set by the
 * main broker) - never the stored price, which is what the main broker pays us.
 * An annulled policy is charged the annulment fee in both cases (the annulled
 * price), exactly like a main broker's bill and the brokers report.
 *
 * @param {object} line  A line from toBillLine.
 * @param {object} row   Its `insurance` row (needed for the tariff lookup).
 * @param {{subPricing?: object, priceFor?: Function}} [pricing]
 * @returns {object} The line with `amount` (charged) and `cost` (our price).
 */
function priceLineForBroker(line, row, pricing) {
  const cost = round2(line.amount);
  if (!pricing || !pricing.subPricing) {
    return { ...line, cost, displayPrice: null, pricingConfigured: true };
  }
  const displayPrice = pricing.priceFor(row, pricing.subPricing);
  const charged = line.annulled
    ? cost
    : displayPrice === null
    ? cost
    : round2(displayPrice);
  return {
    ...line,
    amount: charged,
    cost,
    displayPrice: displayPrice === null ? null : round2(displayPrice),
    pricingConfigured: displayPrice !== null,
  };
}
module.exports.priceLineForBroker = priceLineForBroker;

/**
 * The refund of one annulled policy: the remaining cash the broker gets back,
 * i.e. the original price minus the annulment tax. While a policy is annulled
 * its `Price` already holds the tax, so `OriginalPrice` is the sale price;
 * older rows without it fall back to `Price`.
 *
 * @param {{Price?: any, OriginalPrice?: any, AnnulFee?: any}} row
 * @param {number} [base]  Price to refund (a sub-broker's display price).
 * @returns {number} 0 when nothing is left to refund.
 */
function refundAmount(row, base) {
  const original =
    row && row.OriginalPrice !== null && row.OriginalPrice !== undefined &&
    String(row.OriginalPrice).trim() !== ""
      ? row.OriginalPrice
      : row && row.Price;
  const price =
    base === undefined ? Number(original) || 0 : Number(base) || 0;
  const fee = Number(row && row.AnnulFee) || 0;
  return Math.max(0, round2(price - fee));
}
module.exports.refundAmount = refundAmount;


/**
 * The figures of one broker's period, before anything is stored: the charged
 * lines (by type), the refund credit, the carried-over balance and - for a
 * sub-broker - the cost to us and the profit. Both the bill creation and the
 * read-only audit use it, so what the admin audits is exactly what is billed.
 *
 * @param {{query: Function}} conn
 * @param {{id: number, Name?: string, ParentBrokerId?: number|null}} broker
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {Promise<object|null>} null when the broker has no policies.
 */
async function computeBillFigures(conn, broker, periodStart, periodEnd) {
  const brokerId = Number(broker && broker.id);
  if (!Number.isInteger(brokerId) || brokerId <= 0) return null;

  const rows = await loadBillLines(conn, brokerId, periodStart, periodEnd);
  if (!rows.length) return null;

  const parentBrokerId =
    Number(broker.ParentBrokerId) > 0 ? Number(broker.ParentBrokerId) : null;
  const isSub = Boolean(parentBrokerId) || isSubBrokerName(broker.Name);

  // A sub-broker is charged its display price; its cost to us stays the stored
  // price, and the difference is the main broker's profit.
  let pricing = null;
  if (isSub) {
    const helpers = subBrokerHelpers();
    const display = await helpers.displayData(conn, brokerId);
    pricing = { subPricing: display.subPricing, priceFor: helpers.priceFor };
  }

  const lines = rows.map((row) =>
    priceLineForBroker(toBillLine(row), row, pricing)
  );
  const summary = summarizeLines(lines);
  const charges = summary.total;
  const costCharges = round2(
    lines.reduce((sum, line) => sum + round2(line.cost), 0)
  );

  // Refunds: policies annulled now that were billed and PAID in an earlier
  // period. The money is already back on the broker's balance (the annulment
  // movement); the bill reports it as a credit of this period.
  const paidPeriods = new Set(
    (await loadBills(conn, brokerId))
      .filter((bill) => bill.status === "paid")
      .map((bill) => bill.periodStart)
  );
  const annulments = await loadAnnulments(conn, brokerId, periodStart, periodEnd);
  const refunds = [];
  let refund = 0;
  let costRefund = 0;
  for (const row of annulments) {
    const ownPeriod = periodStartFor(row.CreationDate);
    // Annulled inside its own period: it is already on this bill at its
    // annulled price, so there is nothing to refund on top of it.
    if (!ownPeriod || ownPeriod >= periodStart) continue;
    if (!paidPeriods.has(ownPeriod)) continue;
    const displayPrice =
      pricing && pricing.subPricing
        ? pricing.priceFor(row, pricing.subPricing)
        : null;
    const amount = refundAmount(
      row,
      displayPrice === null ? undefined : displayPrice
    );
    const cost = refundAmount(row);
    refund = round2(refund + amount);
    costRefund = round2(costRefund + cost);
    refunds.push({
      policyNumber: String(row.PolicyNumber ?? "").trim(),
      blancNumber: String(row.BlancNumber ?? "").trim(),
      carNumber: String(row.CarNumber ?? "").trim(),
      type: policyType(row),
      billedPeriod: ownPeriod,
      price:
        displayPrice === null
          ? round2(
              row.OriginalPrice !== null && row.OriginalPrice !== undefined
                ? row.OriginalPrice
                : row.Price
            )
          : round2(displayPrice),
      annulFee: round2(row.AnnulFee),
      amount,
      cost,
      annulledAt: dateTimeOnly(row.AnnulDate),
    });
  }

  const opening = await loadOpeningBalance(conn, brokerId, periodStart);
  const amount = round2(charges - refund);
  const costToUs = isSub ? round2(costCharges - costRefund) : null;
  const profit = isSub ? round2(amount - costToUs) : null;

  return {
    brokerId,
    isSub,
    parentBrokerId,
    lines,
    summary,
    charges,
    refunds,
    refund,
    // Positive = the broker owed money when the period started.
    carriedOver: round2(-opening),
    amount,
    costToUs,
    profit,
  };
}
module.exports.computeBillFigures = computeBillFigures;

/**
 * Create the bill of one broker for one period (idempotent: a bill that is
 * already stored is returned untouched).
 *
 * Charges are the period's policies; refunds are the earlier-period policies
 * that were already billed and PAID and are annulled inside this period. The
 * amount due is `charges - refunds`.
 *
 * @param {{query: Function}} conn
 * @param {{id: number, Name?: string, ParentBrokerId?: number|null}} broker
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {Promise<{created: boolean, bill: object|null, reason?: string}>}
 */
async function createBill(conn, broker, periodStart, periodEnd) {
  await ensureBillTable(conn);
  const brokerId = Number(broker && broker.id);
  if (!Number.isInteger(brokerId) || brokerId <= 0) {
    return { created: false, bill: null, reason: "invalid broker" };
  }

  const figures = await computeBillFigures(conn, broker, periodStart, periodEnd);
  if (!figures) {
    return { created: false, bill: null, reason: "no policies" };
  }

  const [[existing]] = await conn.query(
    "SELECT id FROM broker_bills WHERE BrokerId = ? AND PeriodStart = ?",
    [brokerId, periodStart]
  );
  if (existing) {
    return {
      created: false,
      bill: await loadBill(conn, brokerId, Number(existing.id)),
    };
  }

  const { isSub, parentBrokerId, summary, charges, refund, amount } = figures;
  const { carriedOver, costToUs, profit, refunds } = figures;
  const createdAt = nowLocal();
  // A refund-only period leaves nothing to pay: it is settled the moment it is
  // created (the credit itself already happened on the broker's balance).
  const settled = amount <= 0;

  const [ins] = await conn.query(
    `INSERT INTO broker_bills
       (BrokerId, PeriodStart, PeriodEnd, Currency, Charges, Refund, Amount,
        PolicyCount, AnnulledCount, CarriedOver, CostToUs, Profit,
        ParentBrokerId, Status, Breakdown, CreatedAt, PaidAt, PaidBy,
        PaymentType, PaymentCurrency, Branch)
     VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      brokerId,
      periodStart,
      periodEnd,
      charges,
      refund,
      amount,
      summary.policies,
      summary.annulled,
      carriedOver,
      costToUs,
      profit,
      parentBrokerId,
      settled ? "paid" : "open",
      JSON.stringify({
        byType: summary.byType,
        refunds,
        sub: isSub
          ? { parentBrokerId, charged: amount, paidToUs: costToUs, profit }
          : null,
      }),
      createdAt,
      settled ? createdAt : null,
      settled ? "system" : null,
      settled ? "refund" : null,
      settled ? "EUR" : null,
      null,
    ]
  );

  return { created: true, bill: await loadBill(conn, brokerId, ins.insertId) };
}
module.exports.createBill = createBill;


/**
 * Close a period: create the bill of every broker that has policies in it.
 *
 * @param {{query: Function}} conn
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {Promise<{period: {periodStart: string, periodEnd: string},
 *                     created: object[], existing: object[], skipped: object[]}>}
 */
async function closePeriod(conn, periodStart, periodEnd) {
  await ensureBillTable(conn);
  const [brokers] = await conn.query(
    "SELECT id, Name, Code, CashBalance, ParentBrokerId FROM brokers WHERE Deleted = 0 ORDER BY id"
  );
  const result = {
    period: { periodStart, periodEnd },
    created: [],
    existing: [],
    skipped: [],
  };
  for (const broker of brokers || []) {
    const outcome = await createBill(conn, broker, periodStart, periodEnd);
    const label = {
      brokerId: Number(broker.id),
      name: broker.Name || "",
      code: broker.Code || "",
    };
    if (outcome.created && outcome.bill) {
      result.created.push({ ...label, billId: Number(outcome.bill.id) });
    } else if (outcome.bill) {
      result.existing.push({ ...label, billId: Number(outcome.bill.id) });
    } else {
      result.skipped.push({ ...label, reason: outcome.reason || "no bill" });
    }
  }
  return result;
}
module.exports.closePeriod = closePeriod;

// Stored breakdown JSON -> { byType, refunds, sub }. A bill written by an older
// server (or a damaged value) degrades to empty lists instead of breaking the
// response.
function parseBreakdown(value) {
  const empty = { byType: [], refunds: [], sub: null };
  if (!value) return empty;
  if (Array.isArray(value)) return { ...empty, byType: value };
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return { ...empty, byType: parsed };
    if (parsed && typeof parsed === "object") {
      return {
        byType: Array.isArray(parsed.byType) ? parsed.byType : [],
        refunds: Array.isArray(parsed.refunds) ? parsed.refunds : [],
        sub: parsed.sub && typeof parsed.sub === "object" ? parsed.sub : null,
      };
    }
  } catch {
    // fall through: a damaged value is not worth an error
  }
  return empty;
}
module.exports.parseBreakdown = parseBreakdown;

/**
 * One bill row as the API returns it (dates as text, breakdown parsed, the
 * comma-separated addresses as a list).
 *
 * @param {object} row  A `broker_bills` row.
 * @returns {object}
 */
function serializeBill(row) {
  const bill = row || {};
  const parsed = parseBreakdown(bill.Breakdown);
  const original =
    bill.OriginalAmount === null || bill.OriginalAmount === undefined
      ? null
      : round2(bill.OriginalAmount);
  return {
    id: Number(bill.id),
    brokerId: Number(bill.BrokerId),
    periodStart: dateOnly(bill.PeriodStart),
    periodEnd: dateOnly(bill.PeriodEnd),
    currency: String(bill.Currency || "EUR"),
    charges: round2(bill.Charges),
    refund: round2(bill.Refund),
    amount: round2(bill.Amount),
    policyCount: Number(bill.PolicyCount) || 0,
    annulledCount: Number(bill.AnnulledCount) || 0,
    carriedOver: round2(bill.CarriedOver),
    // Sub-brokers only: what the main broker pays us and what it keeps.
    costToUs:
      bill.CostToUs === null || bill.CostToUs === undefined
        ? null
        : round2(bill.CostToUs),
    profit:
      bill.Profit === null || bill.Profit === undefined
        ? null
        : round2(bill.Profit),
    parentBrokerId: Number(bill.ParentBrokerId) || null,
    status: String(bill.Status || "open"),
    breakdown: parsed.byType,
    refunds: parsed.refunds,
    sub: parsed.sub,
    // An adjusted bill keeps what it was before the admin changed it.
    originalAmount: original,
    adjustment: original === null ? null : round2(round2(bill.Amount) - original),
    adjustReason: String(bill.AdjustReason || ""),
    adjustedBy: bill.AdjustedBy || null,
    adjustedAt: dateTimeOnly(bill.AdjustedAt) || null,
    createdAt: dateTimeOnly(bill.CreatedAt) || null,
    emailedAt: dateTimeOnly(bill.EmailedAt) || null,
    emails: String(bill.Emails || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
    mailAttempts: Number(bill.MailAttempts) || 0,
    mailError: String(bill.MailError || ""),
    paidAt: dateTimeOnly(bill.PaidAt) || null,
    paidBy: bill.PaidBy || null,
    paymentType: bill.PaymentType || null,
    paymentCurrency: bill.PaymentCurrency || null,
    branch: bill.Branch || null,
  };
}
module.exports.serializeBill = serializeBill;


/**
 * The bills of one broker, newest period first.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {{status?: string}} [options]
 * @returns {Promise<object[]>} Serialized bills.
 */
async function loadBills(conn, brokerId, options = {}) {
  await ensureBillTable(conn);
  const status = String(options.status ?? "").trim();
  const [rows] = await conn.query(
    `SELECT * FROM broker_bills
      WHERE BrokerId = ?${status ? " AND Status = ?" : ""}
      ORDER BY PeriodStart DESC, id DESC`,
    status ? [brokerId, status] : [brokerId]
  );
  return (rows || []).map(serializeBill);
}
module.exports.loadBills = loadBills;

/**
 * One bill of a broker.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @param {number} billId
 * @returns {Promise<object|null>} Serialized bill.
 */
async function loadBill(conn, brokerId, billId) {
  const [rows] = await conn.query(
    "SELECT * FROM broker_bills WHERE BrokerId = ? AND id = ?",
    [brokerId, billId]
  );
  const row = (rows || [])[0];
  return row ? serializeBill(row) : null;
}
module.exports.loadBill = loadBill;

/**
 * What is still owed on a list of bills (the ones that are not paid).
 *
 * @param {object[]} bills  Serialized bills, newest first.
 * @returns {{total: number, count: number, oldestPeriodStart: string|null,
 *            lastUnpaidId: number|null}}
 */
function outstandingOf(bills) {
  // A bill with nothing left to pay (a refund-only period, or a bill an admin
  // adjusted down to zero) is never payable, even if it is still "open".
  const unpaid = (bills || []).filter(
    (b) => b.status !== "paid" && round2(b.amount) > 0
  );
  const total = round2(unpaid.reduce((sum, b) => sum + round2(b.amount), 0));
  // `bills` is newest first, so the last one is the oldest open period.
  const oldest = unpaid.length ? unpaid[unpaid.length - 1] : null;
  return {
    total,
    count: unpaid.length,
    oldestPeriodStart: oldest ? oldest.periodStart : null,
    lastUnpaidId: unpaid.length ? Number(unpaid[0].id) : null,
  };
}
module.exports.outstandingOf = outstandingOf;


/**
 * Tag a bill as paid. Only an open bill is touched, so a double confirmation
 * cannot mark (and therefore count) the same bill twice.
 *
 * @param {{query: Function}} conn
 * @param {number} billId
 * @param {{paidAt?: string, paidBy?: string, paymentType?: string,
 *          currency?: string, branch?: string}} info
 * @returns {Promise<number>} affected rows (1 = it was open and is now paid).
 */
async function markBillPaid(conn, billId, info = {}) {
  const [res] = await conn.query(
    `UPDATE broker_bills
        SET Status = 'paid', PaidAt = ?, PaidBy = ?, PaymentType = ?,
            PaymentCurrency = ?, Branch = ?
      WHERE id = ? AND Status <> 'paid'`,
    [
      info.paidAt || nowLocal(),
      String(info.paidBy ?? "").slice(0, 45),
      info.paymentType ? String(info.paymentType).slice(0, 20) : null,
      info.currency ? String(info.currency).slice(0, 3) : null,
      info.branch ? String(info.branch).slice(0, 45) : null,
      billId,
    ]
  );
  return Number(res && res.affectedRows) || 0;
}
module.exports.markBillPaid = markBillPaid;

/**
 * Record that the bill's Excel file reached the broker's addresses.
 *
 * @param {{query: Function}} conn
 * @param {number} billId
 * @param {{emails?: string[], at?: string}} info
 * @returns {Promise<void>}
 */
async function markBillEmailed(conn, billId, info = {}) {
  const emails = (info.emails || []).join(", ").slice(0, 1000);
  await conn.query(
    `UPDATE broker_bills
        SET EmailedAt = ?, Emails = ?, MailError = '',
            MailAttempts = MailAttempts + 1
      WHERE id = ?`,
    [info.at || nowLocal(), emails, billId]
  );
}
module.exports.markBillEmailed = markBillEmailed;

/**
 * Record a failed mail attempt, so the sender retries a few times and then
 * stops (a broker without any email address must not be retried forever).
 *
 * @param {{query: Function}} conn
 * @param {number} billId
 * @param {string} error
 * @returns {Promise<void>}
 */
async function markBillMailFailed(conn, billId, error) {
  await conn.query(
    `UPDATE broker_bills
        SET MailAttempts = MailAttempts + 1, MailError = ?
      WHERE id = ?`,
    [String(error ?? "").slice(0, 255), billId]
  );
}
module.exports.markBillMailFailed = markBillMailFailed;

/**
 * Bills that still have to reach their recipient, with the addresses they go
 * to. A sub-broker is NEVER mailed: its bill goes to the main broker
 * (`ParentBrokerId`), who settles with us for it.
 *
 * @param {{query: Function}} conn
 * @param {number} [maxAttempts]  Bills already tried this often are left alone
 *                                (they show the error in the client instead).
 * @returns {Promise<object[]>} [{ bill, brokerName, brokerCode, emails,
 *                                 recipientBrokerId, recipientName, isSub }]
 */
async function loadBillsToMail(conn, maxAttempts = 3) {
  await ensureBillTable(conn);
  const [rows] = await conn.query(
    `SELECT b.*, br.Name AS BrokerName, br.Code AS BrokerCode,
            br.ParentBrokerId AS BrokerParentId,
            parent.Name AS ParentBrokerName
       FROM broker_bills b
       JOIN brokers br ON br.id = b.BrokerId
       LEFT JOIN brokers parent ON parent.id = br.ParentBrokerId
      WHERE b.EmailedAt IS NULL AND b.MailAttempts < ?
      ORDER BY b.id`,
    [Number(maxAttempts) || 0]
  );
  if (!rows || rows.length === 0) return [];

  const [emailRows] = await conn.query(
    "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
  );
  const byBroker = new Map();
  for (const row of emailRows || []) {
    const key = Number(row.BrokerId);
    if (!byBroker.has(key)) byBroker.set(key, []);
    byBroker.get(key).push(String(row.Email || "").trim());
  }
  const emailsOf = (brokerId) =>
    (byBroker.get(Number(brokerId)) || []).filter(Boolean);

  return rows.map((row) => {
    const brokerName = String(row.BrokerName || "");
    const parentId = Number(row.BrokerParentId) || null;
    const isSub = Boolean(parentId) || isSubBrokerName(brokerName);
    // A sub-broker's bill is sent to its main broker, never to the sub itself.
    const recipientBrokerId = isSub && parentId ? parentId : Number(row.BrokerId);
    return {
      bill: serializeBill(row),
      brokerName,
      brokerCode: String(row.BrokerCode || ""),
      emails: isSub && !parentId ? [] : emailsOf(recipientBrokerId),
      recipientBrokerId,
      recipientName:
        isSub && parentId ? String(row.ParentBrokerName || "") : brokerName,
      isSub,
      subWithoutParent: isSub && !parentId,
    };
  });
}
module.exports.loadBillsToMail = loadBillsToMail;

/**
 * Adjust a bill an admin is disputing: the new amount, why, and who did it. The
 * previous amount is kept in `OriginalAmount` (only the first adjustment sets
 * it), so the documents can show "was X, now Y". Only an unpaid bill can be
 * adjusted - a paid one is corrected through the balance ledger instead.
 *
 * @param {{query: Function}} conn
 * @param {number} billId
 * @param {{amount: number, reason?: string, author?: string}} info
 * @returns {Promise<number>} affected rows (0 = not found or already paid).
 */
async function adjustBill(conn, billId, info = {}) {
  const amount = round2(info.amount);
  const [res] = await conn.query(
    `UPDATE broker_bills
        SET OriginalAmount = COALESCE(OriginalAmount, Amount),
            Amount = ?, AdjustReason = ?, AdjustedBy = ?, AdjustedAt = ?
      WHERE id = ? AND Status <> 'paid'`,
    [
      amount,
      String(info.reason ?? "").slice(0, 255),
      String(info.author ?? "").slice(0, 45),
      info.adjustedAt || nowLocal(),
      billId,
    ]
  );
  return Number(res && res.affectedRows) || 0;
}
module.exports.adjustBill = adjustBill;

/**
 * The lines a bill's documents show: the period's policies priced the way the
 * bill charges them (a sub-broker sees its display price, a main broker its
 * stored price).
 *
 * @param {{query: Function}} conn
 * @param {object} bill  A serialized bill.
 * @returns {Promise<object[]>}
 */
async function loadBillDocumentLines(conn, bill) {
  const brokerId = Number(bill && bill.brokerId);
  const rows = await loadBillLines(
    conn,
    brokerId,
    bill.periodStart,
    bill.periodEnd
  );
  let pricing = null;
  if (bill && bill.sub) {
    const helpers = subBrokerHelpers();
    const display = await helpers.displayData(conn, brokerId);
    pricing = { subPricing: display.subPricing, priceFor: helpers.priceFor };
  }
  return rows.map((row) => priceLineForBroker(toBillLine(row), row, pricing));
}
module.exports.loadBillDocumentLines = loadBillDocumentLines;

/**
 * Who a broker's bill has to reach: the broker itself, or - for a sub-broker -
 * its main broker. A sub-broker is never mailed.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId
 * @returns {Promise<{brokerId: number, name: string, code: string, isSub: boolean,
 *                    parentBrokerId: number|null, recipientBrokerId: number,
 *                    recipientName: string, emails: string[],
 *                    subWithoutParent: boolean}|null>}
 */
async function loadMailTarget(conn, brokerId) {
  const [[broker]] = await conn.query(
    "SELECT id, Name, Code, ParentBrokerId FROM brokers WHERE id = ?",
    [brokerId]
  );
  if (!broker) return null;

  const name = String(broker.Name || "");
  const parentId = Number(broker.ParentBrokerId) || 0;
  const isSub = Boolean(parentId) || isSubBrokerName(name);
  let parentName = "";
  if (parentId) {
    const [[parent]] = await conn.query("SELECT Name FROM brokers WHERE id = ?", [
      parentId,
    ]);
    parentName = String((parent && parent.Name) || "");
  }
  const recipientBrokerId = isSub && parentId ? parentId : Number(broker.id);
  const [emails] = await conn.query(
    "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
    [recipientBrokerId]
  );
  return {
    brokerId: Number(broker.id),
    name,
    code: String(broker.Code || ""),
    isSub,
    parentBrokerId: parentId || null,
    recipientBrokerId,
    recipientName: isSub && parentId ? parentName : name,
    emails: (emails || []).map((r) => String(r.Email || "").trim()).filter(Boolean),
    subWithoutParent: isSub && !parentId,
  };
}
module.exports.loadMailTarget = loadMailTarget;

/**
 * Forget that a bill was mailed, so the next billing run sends it again (used
 * when an admin re-issues a bill without mailing it right away).
 *
 * @param {{query: Function}} conn
 * @param {number} billId
 * @returns {Promise<void>}
 */
async function markBillNotMailed(conn, billId) {
  await conn.query(
    `UPDATE broker_bills
        SET EmailedAt = NULL, MailAttempts = 0, MailError = ''
      WHERE id = ?`,
    [billId]
  );
}
module.exports.markBillNotMailed = markBillNotMailed;

module.exports.periodFor = periodFor;
module.exports.previousPeriod = previousPeriod;
module.exports.periodStartFor = periodStartFor;


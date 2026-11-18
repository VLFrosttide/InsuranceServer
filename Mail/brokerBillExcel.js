"use strict";
// The Excel file and the text of a broker's bi-weekly bill.
//
// One sheet, laid out like an invoice:
//
//   BILL / СМЕТКА
//   Broker: <name> (<code>)
//   Period: 16.11.2026 - 29.11.2026
//   Bill no. <id>, issued <date>
//
//   #  Date  Policy  Blanc  Car  Type  Days  Currency  Amount  Status
//   ...one row per insurance created in the period, annulled ones marked and
//      shown at their annulled price
//
//   By type:   Automobile 10 x 19.00 = 190.00 EUR   (one line per type)
//   TOTAL
//
// The same numbers go into the email body (buildBillText), so a broker who
// reads the mail without opening the file sees exactly the same bill.

const { buildXlsxFile } = require("./xlsxWriter.js");
const { summarizeLines } = require("../db/brokerBills.js");

const LABELS = {
  bg: {
    title: "СМЕТКА ЗА БРОКЕРСКА ДЕЙНОСТ",
    broker: "Брокер",
    period: "Период",
    billNo: "Сметка №",
    issued: "Издадена",
    colNo: "№",
    colDate: "Дата",
    colPolicy: "Полица",
    colBlanc: "Бланка",
    colCar: "Автомобил",
    colType: "Вид",
    colDays: "Срок",
    colCurrency: "Валута",
    colAmount: "Сума",
    colStatus: "Статус",
    annulled: "Анулирана",
    active: "",
    byType: "Обобщение по вид",
    count: "Брой",
    sum: "Сума",
    total: "ОБЩО ЗА ПЕРИОДА",
    policies: "полици",
    carriedOver: "Салдо от предишен период",
    refundsTitle: "Анулирани след плащане (кредит за брокера)",
    refundsNone: "",
    refundLine: "цена {price} − такса {fee} = {amount}",
    refundTotal: "КРЕДИТ ОТ АНУЛАЦИИ",
    amountDue: "ДЪЛЖИМА СУМА",
    nextCredit: "Кредит към следващия период",
    chargesLine: "Начислено за периода",
    subTitle: "Суб-брокер",
    subCharged: "За плащане от суб-брокера",
    subPaidToUs: "За плащане към нас",
    subProfit: "Печалба",
    adjustedTitle: "КОРИГИРАНА СМЕТКА",
    adjustedLine: "Първоначална сума {was}, коригирана на {now}",
    adjustedReason: "Причина",
    adjustedBy: "Коригирана от",
    note:
      "Анулираните полици са отчетени с анулационната такса, не с първоначалната цена.",
    typeFallback: "Друг",
  },
  en: {
    title: "BROKER BILL",
    broker: "Broker",
    period: "Period",
    billNo: "Bill no.",
    issued: "Issued",
    colNo: "No.",
    colDate: "Date",
    colPolicy: "Policy",
    colBlanc: "Blanc",
    colCar: "Car",
    colType: "Type",
    colDays: "Days",
    colCurrency: "Currency",
    colAmount: "Amount",
    colStatus: "Status",
    annulled: "Annulled",
    active: "",
    byType: "Summary by type",
    count: "Count",
    sum: "Sum",
    total: "TOTAL FOR THE PERIOD",
    policies: "policies",
    carriedOver: "Balance carried over",
    refundsTitle: "Annulled after payment (credit to the broker)",
    refundsNone: "",
    refundLine: "price {price} - fee {fee} = {amount}",
    refundTotal: "REFUND CREDIT",
    amountDue: "AMOUNT DUE",
    nextCredit: "Credit carried to the next period",
    chargesLine: "Charged for the period",
    subTitle: "Sub-broker",
    subCharged: "Charged to the sub-broker",
    subPaidToUs: "Payable to us",
    subProfit: "Profit",
    adjustedTitle: "ADJUSTED BILL",
    adjustedLine: "Was {was}, adjusted to {now}",
    adjustedReason: "Reason",
    adjustedBy: "Adjusted by",
    note:
      "Annulled policies are charged at the annulment fee, not at the original price.",
    typeFallback: "Other",
  },
};

// "2026-11-16" -> "16.11.2026" (the way the brokers and the client write it).
function formatDay(ymd) {
  const parts = String(ymd || "").slice(0, 10).split("-");
  if (parts.length !== 3) return String(ymd || "");
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}
module.exports.formatDay = formatDay;

// "16.11.2026 - 29.11.2026"
function periodLabel(bill, separator = " - ") {
  return `${formatDay(bill && bill.periodStart)}${separator}${formatDay(
    bill && bill.periodEnd
  )}`;
}
module.exports.periodLabel = periodLabel;

// "2026-11-16 14:03:00" -> "16.11.2026 14:03"
function formatStamp(value) {
  const text = String(value || "");
  if (text.length < 10) return "";
  return `${formatDay(text.slice(0, 10))} ${text.slice(11, 16)}`.trim();
}
module.exports.formatStamp = formatStamp;

function language(lang) {
  return LABELS[String(lang || "bg").toLowerCase()] || LABELS.bg;
}
module.exports.language = language;

// Two decimals, no thousands separators: what Excel and the mail read best.
function money(value) {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}
module.exports.money = money;

/**
 * The bill's rows in the spreadsheet: title block, the period's policies, the
 * type summary, the refund credit, the amount due and - for a sub-broker - the
 * three figures the main broker needs.
 *
 * @param {{bill: object, lines: object[], brokerName?: string,
 *          brokerCode?: string, lang?: string}} input
 * @returns {Array<Array<any>>}
 */
function buildBillRows({ bill, lines, brokerName, brokerCode, lang } = {}) {
  const L = language(lang);
  const body = Array.isArray(lines) ? lines : [];
  const summary = summarizeLines(body);
  const byType =
    bill && Array.isArray(bill.breakdown) && bill.breakdown.length
      ? bill.breakdown
      : summary.byType;
  const head = { style: "header" };
  const moneyCell = (value) => ({
    value: Math.round((Number(value) || 0) * 100) / 100,
    style: "money",
  });

  const who = [brokerName || ""];
  if (brokerCode) who.push(`(${brokerCode})`);
  if (bill && bill.sub) who.push(`· ${L.subTitle}`);

  const rows = [
    [{ value: L.title, ...head }],
    [`${L.broker}: ${who.filter(Boolean).join(" ")}`],
    [`${L.period}: ${periodLabel(bill)}`],
    [
      `${L.billNo} ${bill && bill.id ? bill.id : "-"}` +
        (bill && bill.createdAt
          ? `   ${L.issued}: ${formatStamp(bill.createdAt)}`
          : ""),
    ],
    [],
    [
      { value: L.colNo, ...head },
      { value: L.colDate, ...head },
      { value: L.colPolicy, ...head },
      { value: L.colBlanc, ...head },
      { value: L.colCar, ...head },
      { value: L.colType, ...head },
      { value: L.colDays, ...head },
      { value: L.colCurrency, ...head },
      { value: L.colAmount, ...head },
      { value: L.colStatus, ...head },
    ],
  ];

  body.forEach((line, index) => {
    rows.push([
      index + 1,
      formatDay(line.creationDate),
      line.policyNumber,
      line.blancNumber,
      line.carNumber,
      line.type || L.typeFallback,
      line.duration || "",
      (bill && bill.currency) || "EUR",
      moneyCell(line.amount),
      line.annulled ? L.annulled : L.active,
    ]);
  });

  rows.push([]);
  rows.push([
    { value: L.byType, ...head },
    { value: L.count, ...head },
    { value: L.sum, ...head },
  ]);
  for (const bucket of byType) {
    rows.push([bucket.type || L.typeFallback, bucket.count, moneyCell(bucket.sum)]);
  }
  const charges = bill && bill.charges !== undefined ? bill.charges : summary.total;
  rows.push([
    { value: `${L.total} (${L.policies}: ${summary.policies})`, ...head },
    { value: summary.policies, ...head },
    moneyCell(charges),
  ]);

  // Refunds: policies of an earlier, already paid period annulled now. The
  // remaining cash (price - annulment fee) is a credit for this period.
  const refunds = (bill && bill.refunds) || [];
  if (refunds.length || Number(bill && bill.refund)) {
    rows.push([]);
    rows.push([{ value: L.refundsTitle, ...head }]);
    for (const refund of refunds) {
      rows.push([
        `#${refund.policyNumber} · ${L.colBlanc} ${refund.blancNumber}` +
          (refund.carNumber ? ` · ${refund.carNumber}` : "") +
          ` · ${formatDay(refund.annulledAt)}` +
          (refund.billedPeriod ? ` (${formatDay(refund.billedPeriod)})` : "") +
          ` · ${L.refundLine
            .replace("{price}", money(refund.price))
            .replace("{fee}", money(refund.annulFee))
            .replace("{amount}", money(refund.amount))}`,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        moneyCell(-Number(refund.amount || 0)),
        null,
      ]);
    }
    rows.push([
      { value: L.refundTotal, ...head },
      { value: null, ...head },
      { value: null, ...head },
      { value: null, ...head },
      { value: null, ...head },
      { value: null, ...head },
      { value: null, ...head },
      { value: null, ...head },
      moneyCell(-Number((bill && bill.refund) || 0)),
      { value: null, ...head },
    ]);
  }

  // A credit larger than the period's charges leaves nothing to pay; the rest
  // stays on the broker's balance and shows on the next bill.
  const due = Math.max(0, Number((bill && bill.amount) || 0));
  rows.push([
    { value: L.amountDue, ...head },
    { value: null, ...head },
    { value: null, ...head },
    { value: null, ...head },
    { value: null, ...head },
    { value: null, ...head },
    { value: null, ...head },
    { value: null, ...head },
    moneyCell(due),
    { value: "EUR", ...head },
  ]);
  if (Number(bill && bill.amount) < 0) {
    rows.push([
      `${L.nextCredit}: ${money(Math.abs(Number(bill.amount)))} EUR`,
    ]);
  }

  if (Number(bill && bill.carriedOver)) {
    rows.push([
      `${L.carriedOver}: ${money(bill.carriedOver)} ${(bill && bill.currency) || "EUR"}`,
    ]);
  }

  // A disputed bill an admin corrected: what it was, what it is now and why.
  if (bill && bill.originalAmount !== null && bill.originalAmount !== undefined) {
    rows.push([]);
    rows.push([{ value: L.adjustedTitle, ...head }]);
    rows.push([
      L.adjustedLine
        .replace("{was}", `${money(bill.originalAmount)} EUR`)
        .replace("{now}", `${money(bill.amount)} EUR`),
    ]);
    if (bill.adjustReason) {
      rows.push([`${L.adjustedReason}: ${bill.adjustReason}`]);
    }
    if (bill.adjustedBy) {
      rows.push([
        `${L.adjustedBy}: ${bill.adjustedBy}${
          bill.adjustedAt ? ` · ${formatStamp(bill.adjustedAt)}` : ""
        }`,
      ]);
    }
  }

  // Sub-broker: what is charged to the sub, what the main broker pays us, and
  // what is left for the main broker.
  if (bill && bill.sub) {
    rows.push([]);
    rows.push([{ value: L.subTitle, ...head }]);
    rows.push([
      `${L.subCharged}: ${money(bill.amount)} EUR`,
    ]);
    rows.push([`${L.subPaidToUs}: ${money(bill.costToUs)} EUR`]);
    rows.push([`${L.subProfit}: ${money(bill.profit)} EUR`]);
  }

  rows.push([]);
  rows.push([L.note]);
  return rows;
}
module.exports.buildBillRows = buildBillRows;

// A file name both Windows and mail clients accept.
function billFileName({ bill, brokerName, brokerCode }) {
  const who = String(brokerCode || brokerName || (bill && bill.brokerId) || "broker")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const from = String((bill && bill.periodStart) || "").replace(/-/g, "");
  const to = String((bill && bill.periodEnd) || "").replace(/-/g, "");
  return `bill-${who}-${from}-${to}.xlsx`;
}
module.exports.billFileName = billFileName;

/**
 * Build the .xlsx attachment of a bill.
 *
 * @param {{bill: object, lines: object[], brokerName?: string,
 *          brokerCode?: string, lang?: string}} input
 * @returns {{filename: string, mimeType: string, base64: string, buffer: Buffer}}
 */
function buildBillWorkbook(input = {}) {
  const bytes = buildXlsxFile({
    sheetName: "Bill",
    widths: [5, 12, 16, 12, 16, 14, 7, 10, 12, 14],
    rows: buildBillRows(input),
  });
  return {
    filename: billFileName(input),
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: Buffer.from(bytes).toString("base64"),
    buffer: bytes,
  };
}
module.exports.buildBillWorkbook = buildBillWorkbook;

/**
 * The bill as plain text: the type summary the broker also sees in the file,
 * used in the email body and by the tests.
 *
 * @param {{bill: object, lines: object[], lang?: string}} input
 * @returns {string}
 */
function buildBillText({ bill, lines, lang } = {}) {
  const L = language(lang);
  const body = Array.isArray(lines) ? lines : [];
  const summary = summarizeLines(body);
  const byType =
    bill && Array.isArray(bill.breakdown) && bill.breakdown.length
      ? bill.breakdown
      : summary.byType;
  const currency = (bill && bill.currency) || "EUR";
  const out = [];
  for (const bucket of byType) {
    out.push(
      `  ${bucket.type || L.typeFallback}: ${bucket.count} x ${money(
        bucket.count ? bucket.sum / bucket.count : 0
      )} = ${money(bucket.sum)} ${currency}`
    );
  }
  out.push(
    `  ${L.total} (${L.policies}: ${summary.policies}): ${money(
      bill && bill.charges !== undefined ? bill.charges : summary.total
    )} ${currency}`
  );

  // The refunds of this period: policies that were already paid for and are
  // annulled now, so the remaining cash comes back as a credit.
  const refunds = (bill && bill.refunds) || [];
  if (refunds.length || Number(bill && bill.refund)) {
    out.push(`  ${L.refundTotal}: -${money((bill && bill.refund) || 0)} ${currency}`);
    for (const refund of refunds) {
      out.push(
        `    #${refund.policyNumber} · ${L.colBlanc} ${refund.blancNumber} · ` +
          L.refundLine
            .replace("{price}", money(refund.price))
            .replace("{fee}", money(refund.annulFee))
            .replace("{amount}", money(refund.amount)) +
          ` ${currency}`
      );
    }
  }

  out.push(`  ${L.amountDue}: ${money(Math.max(0, Number((bill && bill.amount) || 0)))} ${currency}`);
  if (Number(bill && bill.amount) < 0) {
    out.push(
      `  ${L.nextCredit}: ${money(Math.abs(Number(bill.amount)))} ${currency}`
    );
  }

  if (summary.annulled) {
    out.push(`  ${L.note}`);
  }
  return out.join("\n");
}
module.exports.buildBillText = buildBillText;


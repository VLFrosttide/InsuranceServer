"use strict";
// The bi-weekly bill email: subject, body and the Excel attachment.
//
// Three drafts are implemented (BILL_EMAIL_VARIANT picks one) so the wording
// can be chosen without touching the code:
//
//   "a" (default) - Bulgarian, formal, full breakdown  (billing.md, sample A)
//   "b"           - Bulgarian, short, one line + file  (billing.md, sample B)
//   "c"           - English, formal, full breakdown    (billing.md, sample C)
//
// The file (Mail/brokerBillExcel.js) always carries the full list of policies;
// the mail only repeats the minimum a broker needs to make sense of it.
//
// Sending goes through the Gmail API exactly like Mail/renewalReminder.js does
// (the first connected inbox is the sender), with the file as a base64
// attachment, so no MIME library is needed.

const mailStore = require("./mailStore.js");
const {
  buildBillWorkbook,
  buildBillText,
  periodLabel,
  formatDay,
  money,
} = require("./brokerBillExcel.js");

const CRLF = "\r\n";

// Which draft is used. Anything unknown falls back to "a".
function emailVariant() {
  const raw = String(process.env.BILL_EMAIL_VARIANT || "a").trim().toLowerCase();
  return ["a", "b", "c"].includes(raw) ? raw : "a";
}
module.exports.emailVariant = emailVariant;

// The language of the attachment follows the chosen draft: the English mail
// gets an English sheet.
function variantLanguage(variant) {
  return variant === "c" ? "en" : "bg";
}
module.exports.variantLanguage = variantLanguage;

// "12 полици (анулирани: 1)" / "12 policies (1 annulled)"
function policyCountLine(bill, lang) {
  const count = Number(bill && bill.policyCount) || 0;
  const annulled = Number(bill && bill.annulledCount) || 0;
  if (lang === "en") {
    return annulled
      ? `${count} policies (${annulled} annulled)`
      : `${count} policies`;
  }
  return annulled ? `${count} полици (анулирани: ${annulled})` : `${count} полици`;
}
module.exports.policyCountLine = policyCountLine;

/**
 * Build the subject and body of a bill email.
 *
 * `recipientName` is who the mail greets: the broker itself, or the MAIN broker
 * when the bill belongs to a sub-broker (a sub is never mailed; its bill goes to
 * the main broker with the three figures: charged to the sub, payable to us,
 * profit).
 *
 * @param {{bill: object, brokerName?: string, recipientName?: string,
 *          lines?: object[], variant?: string}} input
 * @returns {{subject: string, body: string, variant: string, lang: string}}
 */
function buildBillMessage({
  bill,
  brokerName,
  recipientName,
  lines,
  variant,
} = {}) {
  const chosen = variant || emailVariant();
  const lang = variantLanguage(chosen);
  const name = String(recipientName || brokerName || "").trim();
  const billedName = String(brokerName || "").trim();
  const period = periodLabel(bill);
  const currency = (bill && bill.currency) || "EUR";
  // A credit larger than the charges leaves nothing to pay.
  const dueAmount = Math.max(0, Number((bill && bill.amount) || 0));
  const amount = `${money(dueAmount)} ${currency}`;
  const nextCredit = Number(bill && bill.amount) < 0
    ? Number(bill.amount)
    : 0;
  const countLine = policyCountLine(bill, lang);
  const breakdown = buildBillText({ bill, lines: lines || [], lang });
  const cutoffDay = nextDay(String((bill && bill.periodEnd) || "").slice(0, 10));
  const signature = "Булсиг / Bulsig";
  const isSub = Boolean(bill && bill.sub);
  const refund = Number(bill && bill.refund) || 0;
  const adjusted =
    bill && bill.originalAmount !== null && bill.originalAmount !== undefined

  const subLineBg = isSub
    ? `Сметката е за суб-брокера ${billedName}.\n`
    : "";
  const subBlockBg = isSub
    ? `\nЗа суб-брокера ${billedName}:\n` +
      `  За плащане от суб-брокера: ${money(bill.amount)} ${currency}\n` +
      `  За плащане към нас: ${money(bill.costToUs)} ${currency}\n` +
      `  Печалба: ${money(bill.profit)} ${currency}\n`
    : "";
  const adjustBg = adjusted
    ? `\nСметката е коригирана: първоначално ${money(
        bill.originalAmount
      )} ${currency}, сега ${money(bill.amount)} ${currency}` +
      (bill.adjustReason ? ` (причина: ${bill.adjustReason})` : "") +
      ".\n"
    : "";
  const refundBg = refund
    ? `\nКредит от анулирани след плащане полици: -${money(refund)} ${currency}.\n`
    : "";
  const creditBg = nextCredit
    ? `\nКредит към следващия период: ${money(Math.abs(nextCredit))} ${currency}.\n`
    : "";

  const subLineEn = isSub
    ? `This bill is for the sub-broker ${billedName}.\n`
    : "";
  const subBlockEn = isSub
    ? `\nSub-broker ${billedName}:\n` +
      `  Charged to the sub-broker: ${money(bill.amount)} ${currency}\n` +
      `  Payable to us: ${money(bill.costToUs)} ${currency}\n` +
      `  Profit: ${money(bill.profit)} ${currency}\n`
    : "";
  const adjustEn = adjusted
    ? `\nThe bill was adjusted: originally ${money(
        bill.originalAmount
      )} ${currency}, now ${money(bill.amount)} ${currency}` +
      (bill.adjustReason ? ` (reason: ${bill.adjustReason})` : "") +
      ".\n"
    : "";
  const refundEn = refund
    ? `\nCredit for policies annulled after payment: -${money(refund)} ${currency}.\n`
    : "";
  const creditEn = nextCredit
    ? `\nCredit carried to the next period: ${money(Math.abs(nextCredit))} ${currency}.\n`
    : "";

  if (chosen === "b") {
    return {
      variant: chosen,
      lang,
      subject: `Сметка ${period} - ${amount}`,
      body:
        `Здравейте${name ? ", " + name : ""},\n\n` +
        `${subLineBg}` +
        `Сметка за периода ${period}: ${amount} (${countLine}).\n` +
        `Списъкът на полиците е в прикачения файл.\n` +
        `${refundBg}${creditBg}${adjustBg}` +
        `\nПоздрави,\n${signature}\n`,
    };
  }

  if (chosen === "c") {
    return {
      variant: chosen,
      lang,
      subject: `Bill ${period} - ${amount}`,
      body:
        `Dear${name ? " " + name : " Sir/Madam"},\n\n` +
        `${subLineEn}` +
        `Please find attached your bill for the period ${period}.\n\n` +
        `Policies: ${countLine}\n` +
        `Amount due: ${amount}\n` +
        `${refundEn}${creditEn}${adjustEn}\n` +
        `Summary by vehicle type:\n${breakdown}\n` +
        `${subBlockEn}\n` +
        `The attached Excel file lists every policy of the period.\n\n` +
        `Please settle the amount by ${formatDay(cutoffDay)}. ` +
        `After that date new policies may be blocked until the balance is cleared.\n\n` +
        `Kind regards,\n${signature}\n`,
    };
  }

  return {
    variant: "a",
    lang,
    subject: `Сметка за периода ${period} - ${amount}`,
    body:
      `Здравейте${name ? ", " + name : ""},\n\n` +
      `${subLineBg}` +
      `Изпращаме Ви сметката за периода ${period}.\n\n` +
      `Полици: ${countLine}\n` +
      `Дължима сума: ${amount}\n` +
      `${refundBg}${creditBg}` +
      `\nОбобщение по вид превозно средство:\n${breakdown}\n` +
      `${subBlockBg}${adjustBg}` +
      `\nПодробният списък на всяка полица (с номера, дата и сума) е в прикачения Excel файл.\n\n` +
      `Моля, уредете сумата до ${formatDay(cutoffDay)}. ` +
      `След тази дата новите застраховки могат да бъдат спрени до уреждане на баланса.\n\n` +
      `Поздрави,\n${signature}\n`,
  };
}
module.exports.buildBillMessage = buildBillMessage;

// "2026-11-29" -> "2026-11-30"
function nextDay(ymd) {
  const parts = String(ymd || "").slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ymd;
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
  return d.toISOString().slice(0, 10);
}
module.exports.nextDay = nextDay;

// --- MIME + sending ----------------------------------------------------------

// Quote non-ASCII in a header so the raw MIME message stays valid (RFC 2047).
function encodeHeader(value) {
  const v = String(value == null ? "" : value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}
module.exports.encodeHeader = encodeHeader;

function makeBoundary() {
  return `----=_BrokerBill_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/**
 * Build the raw RFC 2822 message of a bill email.
 *
 * @param {{to: string[]|string, subject: string, body: string,
 *          attachment?: {filename: string, mimeType: string, base64: string}}} mail
 * @returns {string} base64url `raw` value for the Gmail API
 */
function buildBillMime({ to, subject, body, attachment } = {}) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((a) => String(a || "").trim())
    .filter(Boolean)
    .join(", ");
  const boundary = makeBoundary();
  const lines = [];

  lines.push(`To: ${encodeHeader(recipients)}${CRLF}`);
  lines.push(`Subject: ${encodeHeader(subject)}${CRLF}`);
  lines.push("MIME-Version: 1.0" + CRLF);
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}`);
  lines.push(CRLF);

  // Body part.
  lines.push(`--${boundary}${CRLF}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"' + CRLF);
  lines.push("Content-Transfer-Encoding: 8bit" + CRLF);
  lines.push(CRLF);
  lines.push(String(body || "").replace(/\r?\n/g, CRLF));
  lines.push(CRLF);

  // The bill itself.
  if (attachment && attachment.base64) {
    const filename = attachment.filename || "bill.xlsx";
    const mimeType = attachment.mimeType || "application/octet-stream";
    lines.push(`--${boundary}${CRLF}`);
    lines.push(
      `Content-Type: ${mimeType}; name="${encodeHeader(filename)}"${CRLF}`
    );
    lines.push("Content-Transfer-Encoding: base64" + CRLF);
    lines.push(
      `Content-Disposition: attachment; filename="${encodeHeader(
        filename
      )}"${CRLF}`
    );
    lines.push(CRLF);
    // Fold base64 into 76-character lines per RFC 2045.
    const b64 = attachment.base64;
    for (let i = 0; i < b64.length; i += 76) {
      lines.push(b64.slice(i, i + 76) + CRLF);
    }
    lines.push(CRLF);
  }

  lines.push(`--${boundary}--${CRLF}`);
  return Buffer.from(lines.join(""), "utf8").toString("base64url");
}
module.exports.buildBillMime = buildBillMime;

// First connected Gmail client; used as the sender of the bills.
function firstGmail() {
  for (const [, gmail] of mailStore.listGmail()) {
    if (gmail) return gmail;
  }
  return null;
}
module.exports.firstGmail = firstGmail;

/**
 * Mail one bill to its recipient, with its Excel file attached. A sub-broker's
 * bill goes to the main broker: `recipientName` is who is greeted and `emails`
 * are the main broker's addresses.
 *
 * @param {{bill: object, brokerName?: string, recipientName?: string,
 *          brokerCode?: string, emails: string[], lines?: object[],
 *          gmail?: object, variant?: string}} input
 * @returns {Promise<{sent: boolean, error?: string, subject?: string}>}
 */
async function sendBillMail({
  bill,
  brokerName,
  recipientName,
  brokerCode,
  emails,
  lines,
  gmail,
  variant,
} = {}) {
  const recipients = (emails || []).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: false, error: "broker has no email address" };
  }

  const client = gmail || firstGmail();
  if (!client) {
    return { sent: false, error: "no Gmail inbox is connected" };
  }

  const chosen = variant || emailVariant();
  const message = buildBillMessage({
    bill,
    brokerName,
    recipientName,
    lines,
    variant: chosen,
  });
  const attachment = buildBillWorkbook({
    bill,
    lines: lines || [],
    brokerName,
    brokerCode,
    lang: variantLanguage(chosen),
  });

  const raw = buildBillMime({
    to: recipients,
    subject: message.subject,
    body: message.body,
    attachment,
  });

  try {
    await client.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  } catch (err) {
    return {
      sent: false,
      error:
        (err && err.message ? err.message : String(err)).slice(0, 250) ||
        "sending failed",
    };
  }

  return { sent: true, subject: message.subject };
}
module.exports.sendBillMail = sendBillMail;


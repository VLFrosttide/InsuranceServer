"use strict";
// Build and send a reply for a handled email using the Gmail API.
//
// The reply keeps the original subject and is threaded to the original message
// (In-Reply-To / References / Gmail threadId) and attaches any files dropped by
// the worker on the insurance form.
const mailStore = require("./mailStore.js");

const CRLF = "\r\n";

// Extract the bare email address from a From/To header value such as
// "John Doe <john@example.com>". Falls back to the raw value when the address
// cannot be parsed.
function extractAddress(value) {
  const v = String(value || "").trim();
  const m = v.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return v;
}

// Quote non-ASCII in a header so the raw MIME message stays valid without
// depending on a full MIME encoder. RFC 2047 "encoded-word" is used for UTF-8.
function encodeHeader(value) {
  const v = String(value == null ? "" : value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function makeBoundary() {
  return `----=_InsuranceReply_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/**
 * Construct a multipart/mixed MIME message that replies to the given email and
 * carries the supplied attachments (base64 strings).
 *
 * @param {Object} email        Original email record from mailStore.
 * @param {Array}  attachments  Array of { filename, mimeType, base64 }.
 * @param {string} bodyText     Optional body text for the reply.
 * @returns {string} Raw RFC 2822 MIME message.
 */
function buildReplyMime(email, attachments = [], bodyText = "") {
  const to = extractAddress(email.from);
  const subject = email.subject || "";
  const replySubject = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;

  const boundary = makeBoundary();
  const lines = [];

  lines.push(`To: ${to}${CRLF}`);
  lines.push(`Subject: ${encodeHeader(replySubject)}${CRLF}`);
  lines.push("MIME-Version: 1.0" + CRLF);
  // Replying as part of the original conversation.
  if (email.messageIdHeader) {
    lines.push(`In-Reply-To: ${email.messageIdHeader}${CRLF}`);
    lines.push(`References: ${email.messageIdHeader}${CRLF}`);
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}`);
  lines.push(CRLF);

  // Body part.
  lines.push(`--${boundary}${CRLF}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"' + CRLF);
  lines.push("Content-Transfer-Encoding: 8bit" + CRLF);
  lines.push(CRLF);
  lines.push((bodyText || "").toString());
  lines.push(CRLF);

  // Attachment parts.
  for (const att of attachments || []) {
    if (!att || !att.base64) continue;
    const filename = att.filename || "attachment";
    const mimeType = att.mimeType || "application/octet-stream";

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
    const b64 = att.base64;
    for (let i = 0; i < b64.length; i += 76) {
      lines.push(b64.slice(i, i + 76) + CRLF);
    }
    lines.push(CRLF);
  }

  lines.push(`--${boundary}--${CRLF}`);

  return Buffer.from(lines.join(""), "utf8").toString("utf8");
}

/**
 * Send a reply to the original sender of a handled email, attaching the files
 * dropped on the insurance form.
 *
 * @param {string} messageId  Gmail message ID of the original email.
 * @param {Array}  attachments Array of { filename, mimeType, base64 }.
 * @param {string} bodyText    Optional body text for the reply.
 * @returns {Promise<Object>}  The Gmail send response (or null when skipped).
 */
function headerValue(headers, name) {
  const h = (headers || []).find(
    (x) => x && x.name && x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

function isNotFoundError(err) {
  const status = err && (err.code || err.status || err.response?.status);
  return Number(status) === 404 || Number(status) === 400;
}

// Fetch just the headers needed for a reply straight from Gmail. Each
// registered inbox is tried in turn because the message ID alone does not tell
// which inbox it belongs to.
async function fetchOriginalFromGmail(messageId) {
  for (const [account, gmail] of mailStore.listGmail()) {
    if (!gmail) continue;
    try {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Message-ID"],
      });
      const msg = res.data || {};
      const headers = msg.payload?.headers || [];
      return {
        account,
        messageId,
        threadId: msg.threadId || "",
        messageIdHeader: headerValue(headers, "Message-ID"),
        from: headerValue(headers, "From"),
        subject: headerValue(headers, "Subject"),
      };
    } catch (err) {
      // Not in this inbox: try the next one. Any other failure is real.
      if (isNotFoundError(err)) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Resolve the original email for a reply. The in-memory mailStore is checked
 * first; when the email is not there (server restart, a different server
 * process, or the card was already completed/dismissed) the headers are
 * fetched directly from Gmail so the reply can still be sent.
 *
 * @param {string} messageId  Gmail message ID of the original email.
 * @returns {Promise<Object|null>}
 */
async function resolveOriginalEmail(messageId) {
  const cached = mailStore.get(messageId);
  if (cached) return cached;
  return fetchOriginalFromGmail(messageId);
}

// How long a reply waits for the Gmail inboxes to finish authorizing right
// after a server (re)start before giving up.
const GMAIL_READY_TIMEOUT_MS =
  Number(process.env.MAIL_READY_TIMEOUT_MS) || 20000;

module.exports.sendReply = async function sendReply(
  messageId,
  attachments = [],
  bodyText = ""
) {
  // The HTTP server accepts requests before the Gmail inboxes are authorized.
  // A reply arriving in that window (e.g. right after a restart) waits for the
  // integration instead of failing with "no Gmail inbox is connected".
  if (!mailStore.get(messageId) && !mailStore.isGmailReady()) {
    await mailStore.waitForGmail(GMAIL_READY_TIMEOUT_MS);
  }

  const email = await resolveOriginalEmail(messageId);
  if (!email) {
    const registered = mailStore.listGmail().length;
    let reason;
    if (registered > 0) {
      reason = "in the mail store or any connected Gmail inbox";
    } else if (!mailStore.isGmailReady()) {
      reason = "the Gmail integration is still starting up, try again shortly";
    } else {
      reason = "no Gmail inbox is connected on the server";
    }
    throw new Error(
      registered > 0
        ? `Original email not found (${messageId}) ${reason}`
        : `Original email not found (${messageId}): ${reason}`
    );
  }

  const gmail = mailStore.getGmail(email.account);
  if (!gmail) {
    throw new Error(`No Gmail client for account "${email.account}"`);
  }

  const raw = buildReplyMime(email, attachments, bodyText);

  return gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: email.threadId || undefined,
      raw: Buffer.from(raw, "utf8").toString("base64url"),
    },
  });
};

module.exports.buildReplyMime = buildReplyMime;
module.exports.extractAddress = extractAddress;

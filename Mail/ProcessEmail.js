"use strict";
const path = require("node:path");
const walkParts = require("./walkParts.js");
const { notifyUnreadEmail } = require("../Users/websocket.js");
const mailStore = require("./mailStore.js");
const { isKnownBrokerSender } = require("./brokerSenders.js");

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function headerValue(headers, name) {
  const h = (headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

function htmlToRoughText(html) {
  const NBSP = "&" + "nbsp;";
  const AMP = "&" + "amp;";
  const LT = "&" + "lt;";
  const GT = "&" + "gt;";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .split(NBSP)
    .join(" ")
    .split(AMP)
    .join("&")
    .split(LT)
    .join("<")
    .split(GT)
    .join(">")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueFileName(name, used) {
  let cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") cleaned = "unnamed";

  const ext = path.extname(cleaned).slice(0, 20);
  let stem =
    cleaned.slice(0, cleaned.length - path.extname(cleaned).length) ||
    "unnamed";
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  if (stem.length > 120) stem = stem.slice(0, 120);

  let candidate = `${stem}${ext}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++)
    candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Inline attachments at most this large as base64 in the WebSocket response.
// Larger attachments are not inlined (the client shows their filename only).
const INLINE_ATTACHMENT_LIMIT = 10 * 1024 * 1024;

/**
 * Lazily resolve one attachment of an email card to its bytes.
 *
 * Attachment bytes are NOT downloaded while polling/listing: the card only
 * carries `{ id, filename, mimeType, size }`. Only when a worker actually
 * opens the card and the client requests this attachment do we fetch it from
 * Gmail (or decode its already-inlined data) and cache the result so it is
 * downloaded at most once.
 *
 * @param {Object} email  Email record from mailStore.
 * @param {string} id     Attachment id as listed on the card.
 * @returns {Promise<Object|null>} { id, filename, mimeType, size, base64 }
 */
module.exports.getAttachment = async function getAttachment(email, id) {
  const att = (email && email.attachments ? email.attachments : []).find(
    (a) => a && a.id === id
  );
  if (!att) return null;

  const src = att._src;
  if (!src) return null;

  let data = src.data || null;
  if (!data) {
    const gmail = mailStore.getGmail(email.account);
    if (!gmail) {
      throw new Error(`No Gmail client for account "${email.account}"`);
    }
    if (src.inlineData) {
      data = decodeBase64Url(src.inlineData);
    } else if (src.attachmentId) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: email.messageId,
        id: src.attachmentId,
      });
      data = decodeBase64Url(res.data.data);
    } else {
      return null;
    }
    src.data = data; // cache so each attachment is downloaded at most once
  }

  let base64 = null;
  if (data.length <= INLINE_ATTACHMENT_LIMIT) {
    base64 = data.toString("base64");
  }

  return {
    id: att.id,
    filename: att.filename,
    mimeType: att.mimeType,
    size: data.length,
    base64,
  };
};

/**
 * Fetch one message and broadcast it to connected clients with attachment
 * metadata only (the bytes are loaded lazily via getAttachment when a card is
 * opened). The message is marked read later, once a worker completes the form.
 *
 * @param {import("googleapis").gmail_v1.Gmail} gmail
 * @param {string} messageId
 * @param {string} account
 * @param {Object} [options]
 * @param {boolean} [options.notify=true]  Broadcast the new card to workers.
 *   Disabled when a reconnecting worker restores an email it still has open
 *   (it is claimed straight away, so other workers should not see a card).
 * @returns {Promise<Object|null>} The stored email, or null when it was
 *   already stored or is not from a known broker.
 */
module.exports.ProcessEmail = async function ProcessEmail(
  gmail,
  messageId,
  account,
  { notify = true } = {}
) {
  // Skip work we already know about (e.g. because the server restarted before
  // a worker completed the form, or because an earlier poll already stored it).
  // The message is only marked read on complete, so it stays "unread" in Gmail
  // and is returned by every subsequent sweep. Checking the store BEFORE
  // fetching the full message avoids re-downloading the entire backlog (body +
  // attachments) every poll cycle — the main source of slow card updates.
  if (mailStore.has(account, messageId)) {
    return null;
  }

  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = res.data;
  const headers = msg.payload?.headers || [];
  const bag = { textParts: [], htmlParts: [], attachmentParts: [] };
  walkParts(msg.payload, messageId, bag);

  let body = bag.textParts.join("\n\n").trim();
  if (!body && bag.htmlParts.length)
    body = htmlToRoughText(bag.htmlParts.join("\n"));
  if (!body && msg.snippet) body = msg.snippet;

  const emailInfo = {
    account,
    messageId,
    threadId: msg.threadId || "",
    messageIdHeader: headerValue(headers, "Message-ID"),
    from: headerValue(headers, "From"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    body: body || "",
    attachments: [],
  };

  // Only emails from a known broker (database / BrokerInfo.js) are shown to
  // clients. Anything else is ignored: never stored, broadcast, or marked read.
  if (!(await isKnownBrokerSender(emailInfo.from))) {
    return null;
  }

  // Store the email so workers can list/claim it after the broadcast.
  mailStore.add(emailInfo);
  // A restored email (notify: false) is read in Gmail and about to be claimed
  // by the reconnecting worker. Stamp it in the same synchronous step as add()
  // so a poll sweep already in flight does not drop it as "read" first.
  if (!notify) mailStore.touchReleased(messageId);

  // Attachments are lazy: only their metadata goes on the card so workers see
  // names/sizes without the server downloading the bytes. The bytes are fetched
  // on demand via getAttachment() once the card is opened. Graphics embedded
  // in the email body (signature logos, icons) are not attachments and are
  // left out, so workers only see the documents the broker actually attached.
  const usedNames = new Set();
  for (const meta of walkParts.selectAttachments(bag)) {
    const filename = uniqueFileName(meta.filename, usedNames);
    const size =
      meta.size ||
      (meta.inlineData
        ? Buffer.from(
            meta.inlineData.replace(/-/g, "+").replace(/_/g, "/"),
            "base64"
          ).length
        : 0);

    const id = `att-${String(messageId).slice(0, 12)}-${emailInfo.attachments.length}`;
    const card = {
      id,
      filename,
      mimeType: meta.mimeType || "application/octet-stream",
      size,
    };
    // Keep the Gmail fetch info on the card but non-enumerable so JSON
    // serialization (list_emails / new_email) never ships it — or the bytes —
    // to clients.
    Object.defineProperty(card, "_src", {
      value: {
        attachmentId: meta.attachmentId || null,
        inlineData: meta.inlineData || null,
        data: null,
      },
      enumerable: false,
      writable: true,
    });
    emailInfo.attachments.push(card);
  }

  // Broadcast the card (body + attachment metadata). Attachment bytes are not
  // included; the client fetches them lazily via get_attachment when opened.
  if (notify) notifyUnreadEmail(emailInfo);
  return emailInfo;
};

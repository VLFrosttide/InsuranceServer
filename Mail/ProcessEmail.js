"use strict";
const fs = require("node:fs");
const path = require("node:path");
const walkParts = require("./walkParts.js");
const { notifyUnreadEmail } = require("../Users/websocket.js");
const mailStore = require("./mailStore.js");

const SAVE_TO_DISK = process.env.SAVE_ATTACHMENTS_TO_DISK !== "0";
const ATTACHMENTS_DIR = path.resolve(
  process.env.GMAIL_ATTACHMENTS_DIR || path.join(process.cwd(), "attachments")
);
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** In-memory store of every attachment found while processing mail. */
const attachments = (module.exports.attachments = []);

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

async function fetchAttachmentBytes(gmail, messageId, meta) {
  if (meta.inlineData) {
    return Buffer.from(
      meta.inlineData.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );
  }
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: meta.attachmentId,
  });
  return Buffer.from(
    res.data.data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
}

/**
 * Fetch one message, broadcast it to connected clients, save attachments, and
 * finally mark the message as read.
 *
 * @param {import("googleapis").gmail_v1.Gmail} gmail
 * @param {string} messageId
 * @param {string} account
 */
module.exports.ProcessEmail = async function ProcessEmail(
  gmail,
  messageId,
  account
) {
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

  // Skip work we already know about (e.g. because the server restarted before
  // a worker completed the form). The message is only marked read on complete.
  if (mailStore.has(account, messageId)) {
    return;
  }

  // Store the email so workers can list/claim it after the broadcast.
  mailStore.add(emailInfo);

  const usedNames = new Set();
  for (const meta of bag.attachmentParts) {
    try {
      const data = await fetchAttachmentBytes(gmail, messageId, meta);
      const filename = uniqueFileName(meta.filename, usedNames);
      const item = {
        account,
        messageId,
        filename,
        mimeType: meta.mimeType,
        size: data.length,
        data,
      };
      attachments.push(item);

      // Expose the attachment to the Electron clients. Only inline a base64
      // payload when it is reasonably small; large files are still saved to
      // disk and can be referenced by filename.
      emailInfo.attachments.push({
        filename,
        mimeType: meta.mimeType || "application/octet-stream",
        size: data.length,
        base64: data.length <= 5 * 1024 * 1024 ? data.toString("base64") : null,
      });

      if (SAVE_TO_DISK) {
        const dir = path.join(ATTACHMENTS_DIR, account, messageId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, filename), data);
      }
    } catch (err) {
      console.error(`Failed to process attachment "${meta.filename}":`, err);
    }
  }

  // Broadcast only after attachments are attached so cards carry the full
  // email (body + pictures) when a worker opens it.
  notifyUnreadEmail(emailInfo);
};

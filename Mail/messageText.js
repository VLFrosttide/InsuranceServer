"use strict";

// Shared Gmail message helpers: header lookup, HTML-to-text conversion and
// body extraction. Used by ProcessEmail.js (a new card) and threadHistory.js
// (the full conversation of a card), so both produce the same text.

const walkParts = require("./walkParts.js");

function headerValue(headers, name) {
  const h = (headers || []).find(
    (x) => x && x.name && x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

function htmlToRoughText(html) {
  const NBSP = "&" + "nbsp;";
  const AMP = "&" + "amp;";
  const LT = "&" + "lt;";
  const GT = "&" + "gt;";
  // Line breaks are kept (block elements become newlines and quoted
  // <blockquote> content gets "> " prefixes) so the client can still split a
  // reply into the separate emails it contains (renderer/emailThread.js).
  // "&amp;" is decoded last, so "&amp;lt;" stays the literal text "&lt;".
  let text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr[^>]*>/gi, "\n________________________________\n")
    .replace(/<blockquote[^>]*>/gi, "\n\u0001")
    .replace(/<\/blockquote\s*>/gi, "\u0002\n")
    .replace(/<\/?(p|div|tr|li|h[1-6]|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(NBSP)
    .join(" ")
    .split(LT)
    .join("<")
    .split(GT)
    .join(">")
    .split(AMP)
    .join("&");

  // Prefix every line inside a <blockquote> with one "> " per nesting level.
  let depth = 0;
  text = text
    .split("\n")
    .map((line) => {
      const lineDepth = depth;
      for (const ch of line) {
        if (ch === "\u0001") depth++;
        else if (ch === "\u0002") depth = Math.max(0, depth - 1);
      }
      const clean = line
        .replace(/[\u0001\u0002]/g, "")
        .replace(/[ \t\f\v\r]+/g, " ")
        .trim();
      const level = Math.max(lineDepth, depth);
      return clean ? "> ".repeat(level) + clean : "";
    })
    .join("\n");

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Read the readable text of one Gmail message payload.
 *
 * @param {Object} payload  `msg.payload` from the Gmail API.
 * @param {string} messageId
 * @param {string} [snippet]
 * @returns {{body: string, bag: {textParts: string[], htmlParts: string[],
 *   attachmentParts: Array}}}
 */
function readMessageBody(payload, messageId, snippet) {
  const bag = { textParts: [], htmlParts: [], attachmentParts: [] };
  walkParts(payload, messageId, bag);

  let body = bag.textParts.join("\n\n").trim();
  if (!body && bag.htmlParts.length) {
    body = htmlToRoughText(bag.htmlParts.join("\n"));
  }
  if (!body && snippet) body = snippet;
  return { body: body || "", bag };
}

module.exports = { headerValue, htmlToRoughText, readMessageBody };

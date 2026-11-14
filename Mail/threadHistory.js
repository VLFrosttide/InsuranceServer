"use strict";

// The full Gmail conversation behind one email card, for the add-insurance
// form's "conversation history" panel.
//
// The dashboard only holds the unread emails; the employee's replies and the
// older client answers live in Gmail itself. Reading the thread gives both
// directions exactly as they were sent, survives server restarts and needs no
// extra database table.

const mailStore = require("./mailStore.js");
const { headerValue, readMessageBody } = require("./messageText.js");

// The bare address inside "Name <address@example.com>".
function extractAddress(value) {
  const text = String(value || "").trim();
  const m = text.match(/<([^>]+)>/);
  return (m ? m[1] : text).trim().toLowerCase();
}

/**
 * Turn Gmail thread messages into the list shown by the client.
 *
 * The original email's sender is the broker; any other sender in the thread
 * is us (the employee), because a Gmail thread only contains the broker and
 * the inbox that received it. `internalDate` is preferred for ordering, with
 * the Date header as a fallback for hand-built payloads in tests.
 *
 * @param {Array} messages  `thread.messages` from the Gmail API.
 * @param {string} brokerFrom  The original email's From header.
 * @returns {Array<{id:string, from:string, date:string, subject:string,
 *   text:string, at:number, direction:("client"|"employee")}>}
 */
function parseThreadMessages(messages, brokerFrom) {
  const brokerAddress = extractAddress(brokerFrom);
  return (messages || [])
    .map((msg) => {
      const headers = (msg && msg.payload && msg.payload.headers) || [];
      const from = headerValue(headers, "From");
      const date = headerValue(headers, "Date");
      const subject = headerValue(headers, "Subject");
      const { body } = readMessageBody(
        (msg && msg.payload) || {},
        (msg && msg.id) || "",
        (msg && msg.snippet) || ""
      );
      const parsed = Date.parse(date);
      const at =
        Number(msg && msg.internalDate) ||
        (Number.isFinite(parsed) ? parsed : 0);
      const sender = extractAddress(from);
      return {
        id: String((msg && msg.id) || ""),
        from,
        date,
        subject,
        text: body,
        at,
        direction:
          brokerAddress && sender !== brokerAddress ? "employee" : "client",
      };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Read one conversation from Gmail.
 *
 * @param {string} messageId  Gmail message ID of an email in the store.
 * @returns {Promise<{messageId:string, threadId:string, subject:string,
 *   messages:Array}|null>} null when the email is not in the store.
 */
async function fetchThreadConversation(messageId) {
  const email = mailStore.get(messageId);
  if (!email) return null;

  const gmail = mailStore.getGmail(email.account);
  if (!gmail) {
    throw new Error(`No Gmail client for account "${email.account}"`);
  }
  if (!email.threadId) {
    // Restored email without a Gmail thread id: only the stored message is
    // known. It is the broker's, so it is shown as one client message.
    const parsed = Date.parse(email.date);
    return {
      messageId,
      threadId: "",
      subject: email.subject || "",
      messages: [
        {
          id: String(email.messageId || ""),
          from: email.from || "",
          date: email.date || "",
          subject: email.subject || "",
          text: email.body || "",
          at: Number.isFinite(parsed) ? parsed : 0,
          direction: "client",
        },
      ],
    };
  }

  const res = await gmail.users.threads.get({
    userId: "me",
    id: email.threadId,
    format: "full",
  });
  const thread = (res && res.data) || {};
  return {
    messageId,
    threadId: email.threadId,
    subject: email.subject || "",
    messages: parseThreadMessages(thread.messages || [], email.from),
  };
}

module.exports = { extractAddress, parseThreadMessages, fetchThreadConversation };

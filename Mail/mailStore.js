"use strict";

// In-memory store of currently unhandled (unread) emails.
//
// - ProcessEmail adds an email here before broadcasting it to workers.
// - The Gmail message is NOT marked read until a worker actually finishes the
//   insurance form (complete), so a server restart naturally re-surfaces any
//   still-unhandled emails on the next poll.
// - While an email is "claimed" by a worker it is excluded from listAll() so
//   other workers do not re-render a card for it.

const activeEmails = new Map(); // messageId -> emailInfo
const claimedBy = new Map(); // messageId -> username

let gmail = null;

module.exports.setGmail = function setGmail(client) {
  gmail = client;
};

module.exports.has = function has(messageId) {
  return activeEmails.has(messageId);
};

module.exports.add = function add(email) {
  activeEmails.set(email.messageId, email);
  return email;
};

module.exports.get = function get(messageId) {
  return activeEmails.get(messageId) || null;
};

// All emails that are currently available for workers to pick up.
module.exports.listAll = function listAll() {
  const out = [];
  for (const email of activeEmails.values()) {
    if (!claimedBy.has(email.messageId)) out.push(email);
  }
  return out;
};

module.exports.claim = function claim(messageId, username) {
  if (claimedBy.has(messageId) && claimedBy.get(messageId) !== username) {
    return false;
  }
  claimedBy.set(messageId, username);
  return true;
};

module.exports.unclaim = function unclaim(messageId) {
  claimedBy.delete(messageId);
};

module.exports.getClaimer = function getClaimer(messageId) {
  return claimedBy.get(messageId) || null;
};

module.exports.remove = function remove(messageId) {
  activeEmails.delete(messageId);
  claimedBy.delete(messageId);
};

module.exports.markRead = async function markRead(messageId) {
  if (!gmail) return;
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
};

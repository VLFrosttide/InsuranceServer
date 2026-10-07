"use strict";

// In-memory store of currently unhandled (unread) emails.
//
// - ProcessEmail adds an email here before broadcasting it to workers.
// - The Gmail message is NOT marked read until a worker actually finishes the
//   insurance form (complete), so a server restart naturally re-surfaces any
//   still-unhandled emails on the next poll.
// - While an email is "claimed" by a worker it is excluded from listAll() so
//   other workers do not re-render a card for it.
//
// Entries are keyed by `account + messageId` so that the same Gmail message ID
// appearing on two different inboxes does not overwrite one another.

const activeEmails = new Map(); // account\u0000messageId -> emailInfo
const claimedBy = new Map(); // account\u0000messageId -> username
const gmailByAccount = new Map(); // account label -> Gmail API client

const KEY_SEP = "\u0000";

function key(account, messageId) {
  return `${account || ""}${KEY_SEP}${messageId}`;
}

// The WebSocket protocol references an email only by its raw Gmail message ID
// (it does not send an account). On the rare cross-account collision the first
// matching entry wins.
function findByMessageId(messageId) {
  for (const email of activeEmails.values()) {
    if (email.messageId === messageId) return email;
  }
  return null;
}

module.exports.setGmail = function setGmail(account, client) {
  gmailByAccount.set(account, client);
};

module.exports.getGmail = function getGmail(account) {
  return gmailByAccount.get(account) || null;
};

// Every registered inbox as [account, client] pairs. Used to look a message up
// directly in Gmail when it is no longer (or not yet) held in memory, e.g.
// after a server restart wiped this in-memory store.
module.exports.listGmail = function listGmail() {
  return Array.from(gmailByAccount.entries());
};

module.exports.has = function has(account, messageId) {
  return activeEmails.has(key(account, messageId));
};

module.exports.add = function add(email) {
  activeEmails.set(key(email.account, email.messageId), email);
  return email;
};

module.exports.get = function get(messageId) {
  return findByMessageId(messageId) || null;
};

// All emails that are currently available for workers to pick up.
module.exports.listAll = function listAll() {
  const out = [];
  for (const email of activeEmails.values()) {
    if (!claimedBy.has(key(email.account, email.messageId))) out.push(email);
  }
  return out;
};

module.exports.claim = function claim(messageId, username) {
  const email = findByMessageId(messageId);
  if (!email) return false;
  const k = key(email.account, email.messageId);
  if (claimedBy.has(k) && claimedBy.get(k) !== username) {
    return false;
  }
  claimedBy.set(k, username);
  return true;
};

module.exports.unclaim = function unclaim(messageId) {
  const email = findByMessageId(messageId);
  if (!email) return;
  claimedBy.delete(key(email.account, email.messageId));
};

module.exports.getClaimer = function getClaimer(messageId) {
  const email = findByMessageId(messageId);
  if (!email) return null;
  return claimedBy.get(key(email.account, email.messageId)) || null;
};

module.exports.remove = function remove(messageId) {
  const email = findByMessageId(messageId);
  if (!email) return;
  const k = key(email.account, email.messageId);
  activeEmails.delete(k);
  claimedBy.delete(k);
};

module.exports.markRead = async function markRead(account, messageId) {
  const gmail = gmailByAccount.get(account);
  if (!gmail) return;
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
};

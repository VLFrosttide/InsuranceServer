"use strict";

// In-memory store of currently unhandled (unread) emails.
//
// - ProcessEmail adds an email here before broadcasting it to workers.
// - The Gmail read state follows the card (see syncReadState): unread while it
//   waits on the dashboard, read while a worker has it open (claimed) and once
//   it is completed/dismissed. Cancelling or a dropped connection marks it
//   unread again, so a server restart re-surfaces still-unhandled emails on the
//   next poll. A worker who reconnects with the form open claims it again.
// - While an email is "claimed" by a worker it is excluded from listAll() so
//   other workers do not re-render a card for it.
//
// Entries are keyed by `account + messageId` so that the same Gmail message ID
// appearing on two different inboxes does not overwrite one another.

const activeEmails = new Map(); // account\u0000messageId -> emailInfo
const claimedBy = new Map(); // account\u0000messageId -> username
const gmailByAccount = new Map(); // account label -> Gmail API client
// account\u0000messageId -> timestamp (ms) of the last time a worker cancelled
// (released) the email. The poller uses it to avoid dropping a just-released
// email whose "mark unread" had not reached Gmail yet when the sweep began.
const releasedAt = new Map();
// Keys of emails removed from the store (completed, dismissed or read in
// Gmail). A reconnecting worker must not bring such an email back by
// re-claiming it. Insertion-ordered and capped so it cannot grow forever.
const handled = new Set();
const HANDLED_LIMIT = 5000;

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

// Every stored email of one inbox (claimed or not), each paired with whether
// it is currently claimed by a worker. Used by the poller to drop emails that
// were read in Gmail outside of this app.
module.exports.listByAccount = function listByAccount(account) {
  const out = [];
  for (const [k, email] of activeEmails) {
    if ((email.account || "") !== (account || "")) continue;
    out.push({
      email,
      claimed: claimedBy.has(k),
      releasedAt: releasedAt.get(k) || 0,
    });
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

// Record "now" as the latest release time of an email. Called when a worker
// cancels the email and again once Gmail confirmed it is unread, so any poll
// sweep that started before either moment will not drop the card.
module.exports.touchReleased = function touchReleased(messageId) {
  const email = findByMessageId(messageId);
  if (!email) return;
  releasedAt.set(key(email.account, email.messageId), Date.now());
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
  releasedAt.delete(k);
  handled.add(k);
  if (handled.size > HANDLED_LIMIT) {
    handled.delete(handled.values().next().value);
  }
};

// Whether an email with this Gmail message ID was removed from the store
// during this server run (see `handled` above).
module.exports.wasHandled = function wasHandled(messageId) {
  for (const k of handled) {
    if (k.slice(k.indexOf(KEY_SEP) + 1) === messageId) return true;
  }
  return false;
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

// account\u0000messageId -> tail of the queue of pending Gmail label changes.
const readStateQueues = new Map();

/**
 * Bring the Gmail read state of one message in line with the store:
 * - stored and not claimed (a card waiting on the dashboard) -> UNREAD
 * - claimed by a worker (form open) or no longer stored (completed/dismissed)
 *   -> READ
 *
 * Calls for the same message run one after another, and each one checks the
 * state when it actually runs (not when it was queued). So the label always
 * ends up matching the latest state, even when release/claim/complete happen
 * in quick succession (e.g. a dropped connection followed by a reconnect).
 *
 * @returns {Promise<void>} Rejects if the Gmail request fails.
 */
module.exports.syncReadState = function syncReadState(account, messageId) {
  const k = key(account, messageId);
  const previous = readStateQueues.get(k) || Promise.resolve();
  const next = previous
    .catch(() => {
      // An earlier failure was already reported to its own caller.
    })
    .then(async () => {
      const waiting = activeEmails.has(k) && !claimedBy.has(k);
      if (waiting) await module.exports.markUnread(account, messageId);
      else await module.exports.markRead(account, messageId);
    });
  readStateQueues.set(k, next);
  next
    .finally(() => {
      if (readStateQueues.get(k) === next) readStateQueues.delete(k);
    })
    .catch(() => {
      // Handled by the caller awaiting `next`.
    });
  return next;
};

// Put the UNREAD label back on a Gmail message (e.g. a worker opened the email
// in the app or in Gmail and then cancelled without completing the form).
module.exports.markUnread = async function markUnread(account, messageId) {
  const gmail = gmailByAccount.get(account);
  if (!gmail) return;
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: ["UNREAD"] },
  });
};

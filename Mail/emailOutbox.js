"use strict";
// Durable retry queue for reply emails that fail to send through the Gmail API.
//
// A reply can fail for many reasons: a transient 5xx from Google ("Internal
// error encountered"), a rate limit (429), a network blip, or a just-expired
// token. Instead of silently losing the reply, SendReply.js hands a failed send
// over to this outbox, which persists it in MySQL and retries it in the
// background with exponential backoff — including after a server restart, since
// jobs live in the database rather than in memory. When a job finally gives up
// it notifies admins and workers through the WebSocket so a human can follow up
// with the broker directly.

const mailStore = require("./mailStore.js");

let db = null;

/** Provide the database pool used to persist and drain jobs. */
function setDb(DBConnection) {
  db = DBConnection;
}

const MAX_ATTEMPTS = Number(process.env.EMAIL_OUTBOX_MAX_ATTEMPTS) || 5;
const DRAIN_INTERVAL_MS =
  Number(process.env.EMAIL_OUTBOX_INTERVAL_MS) || 60 * 1000;
const BASE_BACKOFF_MS =
  Number(process.env.EMAIL_OUTBOX_BASE_BACKOFF_MS) || 60 * 1000;
const MAX_BACKOFF_MS =
  Number(process.env.EMAIL_OUTBOX_MAX_BACKOFF_MS) || 60 * 60 * 1000;

function backoffFor(attempts) {
  return Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1))
  );
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Notify admins and workers through the WebSocket that a reply email could not
 * be delivered, so a human knows the broker never received their reply.
 *
 * @param {Object} info  { messageId, recipient, subject, attempts, status, error }
 */
function notifyFailure(info) {
  try {
    // Lazy require avoids any load-order coupling with the WebSocket server.
    const { notifyEmailSendFailed } = require("../Users/websocket.js");
    notifyEmailSendFailed({
      messageId: info.messageId || "",
      recipient: info.recipient || "",
      subject: info.subject || "",
      attempts: info.attempts || 0,
      status: info.status || "failed",
      error: info.error || "",
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Failed to notify about an email send failure:", err);
  }
}

/**
 * Persist a failed reply so the background worker retries it later.
 *
 * @returns {Promise<boolean>} true when the job was queued.
 */
async function enqueue({
  messageId,
  attachments = [],
  bodyText = "",
  account = "",
  recipient = "",
  subject = "",
  lastError = "",
}) {
  if (!db) return false;
  const attachmentsJson = JSON.stringify(
    Array.isArray(attachments) ? attachments : []
  );
  // First background retry goes out after one backoff period; later retries
  // grow exponentially inside drain() (see backoffFor / defer).
  const nextAttemptAt = new Date(Date.now() + backoffFor(1));
  await db.query(
    `INSERT INTO email_outbox
       (MessageId, Account, Recipient, Subject, Attachments, BodyText,
        Status, Attempts, NextAttemptAt, LastError)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [
      String(messageId),
      account,
      recipient,
      subject,
      attachmentsJson,
      bodyText,
      nextAttemptAt,
      String(lastError).slice(0, 500),
    ]
  );
  return true;
}

async function markSent(id) {
  if (!db) return;
  await db.query("UPDATE email_outbox SET Status = 'sent' WHERE id = ?", [id]);
}

async function markFailed(id, lastError) {
  if (!db) return;
  await db.query(
    "UPDATE email_outbox SET Status = 'failed', LastError = ?, NextAttemptAt = NOW() WHERE id = ?",
    [String(lastError).slice(0, 500), id]
  );
}

async function defer(id, attempts, lastError) {
  if (!db) return;
  // `attempts` is the attempt number that just failed; schedule the next one
  // after backoffFor(attempts + 1) so delays double each retry.
  const nextAttemptAt = new Date(Date.now() + backoffFor(attempts + 1));
  await db.query(
    "UPDATE email_outbox SET Attempts = ?, LastError = ?, NextAttemptAt = ? WHERE id = ?",
    [attempts, String(lastError).slice(0, 500), nextAttemptAt, id]
  );
}

let draining = false;

/**
 * Retry every due job once. Runs in the background and skips itself while a
 * previous pass is still running or while the Gmail integration is not ready.
 */
async function drain() {
  if (!db || draining) return;
  if (!mailStore.isGmailReady()) return;

  draining = true;
  try {
    const [rows] = await db.query(
      `SELECT * FROM email_outbox
        WHERE Status = 'pending' AND NextAttemptAt <= NOW()
        ORDER BY NextAttemptAt ASC
        LIMIT ?`,
      [20]
    );
    if (!rows || rows.length === 0) return;

    // Lazy require avoids a load-time cycle: SendReply.js requires this module.
    const { sendReplyOnce, isRetryableError } = require("./SendReply.js");

    for (const job of rows) {
      let attachments = [];
      try {
        attachments = job.Attachments ? JSON.parse(job.Attachments) : [];
      } catch {
        attachments = [];
      }

      try {
        await sendReplyOnce(job.MessageId, attachments, job.BodyText || "");
        await markSent(job.id);
        console.log(
          `Sent queued reply email for message "${job.MessageId}" (attempt ${
            Number(job.Attempts || 0) + 1
          })`
        );
      } catch (err) {
        const message = errorText(err);
        const attempts = Number(job.Attempts || 0) + 1;

        if (!isRetryableError(err) || attempts >= MAX_ATTEMPTS) {
          await markFailed(job.id, message);
          console.error(
            `Giving up on reply email "${job.MessageId}" after ${attempts} attempt(s): ${message}`
          );
          notifyFailure({
            messageId: job.MessageId,
            recipient: job.Recipient || "",
            subject: job.Subject || "",
            attempts,
            status: "failed",
            error: message,
          });
        } else {
          await defer(job.id, attempts, message);
          console.warn(
            `Reply email "${job.MessageId}" send attempt ${attempts} failed, will retry: ${message}`
          );
        }
      }
    }
  } catch (err) {
    console.error("Failed to drain the email outbox:", err);
  } finally {
    draining = false;
  }
}

let started = false;

/** Start the background retry worker (idempotent). */
function start() {
  if (started) return;
  started = true;
  const tick = () =>
    drain().catch((err) => console.error("Email outbox drain failed:", err));
  setInterval(tick, DRAIN_INTERVAL_MS);
  // Run an immediate pass so jobs that are already due (e.g. after a restart
  // or after the Gmail integration came up late) are retried without waiting
  // a full interval.
  tick();
}

module.exports = { setDb, enqueue, drain, start, notifyFailure };

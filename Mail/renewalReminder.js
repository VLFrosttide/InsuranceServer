"use strict";
// Weekly best-effort reminder to the developer to refresh the Gmail OAuth
// tokens. `startWeeklyRefreshReminder()` is called once when the Gmail
// integration comes up (see Mail/Mail.js); from then on it sends a single email
// each Saturday so the refresh tokens get renewed before Google's testing-mode
// refresh tokens (which expire after 7 days) stop working.
const mailStore = require("./mailStore.js");

// Current developer. Override with TOKEN_REMINDER_EMAIL if the reminder should
// go elsewhere.
const REMINDER_TO = process.env.TOKEN_REMINDER_EMAIL || "shacxd@gmail.com";

// How often the scheduler wakes up to check whether today is Saturday. An hour
// is plenty: the reminder just has to go out once, sometime on Saturday.
const CHECK_INTERVAL_MS =
  Number(process.env.TOKEN_REMINDER_CHECK_INTERVAL_MS) || 60 * 60 * 1000;

// Saturday's local date key already reminded during this process run. This is a
// fast in-memory guard for the hourly ticks (and the immediate startup check).
// The database (see below) is the durable source of truth across restarts.
let remindedSaturday = null;

// Database connection/pool used to persist the last-reminded Saturday across
// restarts. Provided by main.js once the connection pool is ready.
let db = null;

function setDb(DBConnection) {
  db = DBConnection;
}

// JS getDay(): 0 = Sunday ... 6 = Saturday.
function isSaturday(date) {
  return date.getDay() === 6;
}

function saturdayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// Last Saturday the reminder was sent, as recorded in the DB (or null when
// unknown / DB unavailable). Returns the same "YYYY-M-D" format as saturdayKey.
async function loadLastRemindedSaturday() {
  if (!db) return null;
  try {
    const [rows] = await db.query(
      "SELECT LastRemindedSaturday FROM gmail_token_reminder WHERE id = 1 LIMIT 1"
    );
    const value = rows && rows[0] && rows[0].LastRemindedSaturday;
    return value == null ? null : String(value).trim();
  } catch (err) {
    console.error(
      "Failed to read Gmail token reminder state:",
      err && err.message ? err.message : err
    );
    return null;
  }
}

// Persist the Saturday that was just reminded, so a restart on the same
// Saturday does not send a duplicate.
async function saveLastRemindedSaturday(key) {
  if (!db) return;
  try {
    await db.query(
      "INSERT INTO gmail_token_reminder (id, LastRemindedSaturday) VALUES (1, ?) ON DUPLICATE KEY UPDATE LastRemindedSaturday = VALUES(LastRemindedSaturday)",
      [key]
    );
  } catch (err) {
    console.error(
      "Failed to persist Gmail token reminder state:",
      err && err.message ? err.message : err
    );
  }
}

// First connected Gmail client; used as the sender of the reminder.
function firstGmail() {
  for (const [, gmail] of mailStore.listGmail()) {
    if (gmail) return gmail;
  }
  return null;
}

function encodeHeader(value) {
  const v = String(value == null ? "" : value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

// Minimal RFC 2822 text/plain message, encoded for the Gmail API's `raw` field.
function buildMime(to, subject, body) {
  const CRLF = "\r\n";
  const lines = [
    `To: ${encodeHeader(to)}${CRLF}`,
    `Subject: ${encodeHeader(subject)}${CRLF}`,
    "MIME-Version: 1.0" + CRLF,
    'Content-Type: text/plain; charset="UTF-8"' + CRLF,
    "Content-Transfer-Encoding: 8bit" + CRLF,
    CRLF,
    String(body == null ? "" : body),
    CRLF,
  ];
  return Buffer.from(lines.join(""), "utf8").toString("base64url");
}

/**
 * Send the weekly token-refresh reminder if today is Saturday and this
 * Saturday has not already been reminded during this process run.
 *
 * @returns {Promise<boolean>} true when a reminder email was sent.
 */
async function sendWeeklyReminder() {
  const now = new Date();
  if (!isSaturday(now)) return false;

  const key = saturdayKey(now);
  if (remindedSaturday === key) return false;

  // Persisted check: was this Saturday already reminded (possibly before a
  // restart)? The DB is the source of truth across restarts; the in-memory
  // value above only short-circuits repeat ticks within one run.
  const persisted = await loadLastRemindedSaturday();
  if (persisted === key) {
    remindedSaturday = key;
    return false;
  }

  const gmail = firstGmail();
  if (!gmail) {
    // Nothing to send the reminder through; try again on a later tick.
    console.warn(
      "Cannot send weekly Gmail token refresh reminder: no connected Gmail inbox."
    );
    return false;
  }

  const subject = "Weekly reminder: refresh the Gmail tokens";
  const body =
    "This is your weekly reminder to refresh the Gmail OAuth tokens. " +
    "Google testing-mode refresh tokens expire after 7 days, so please renew " +
    "the tokens before the refresh token stops working.\n";

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: buildMime(REMINDER_TO, subject, body) },
  });

  // Record it durably (and in memory) so a restart on the same Saturday does
  // not send a duplicate.
  remindedSaturday = key;
  await saveLastRemindedSaturday(key);

  console.log(`Sent weekly Gmail token refresh reminder to ${REMINDER_TO}`);
  return true;
}

/**
 * Start the weekly Saturday reminder. Runs an immediate check (in case the
 * server comes up on a Saturday) and then re-checks every CHECK_INTERVAL_MS.
 */
function startWeeklyRefreshReminder() {
  const tick = () => {
    sendWeeklyReminder().catch((err) =>
      console.error(
        "Failed to send weekly Gmail token refresh reminder:",
        err && err.message ? err.message : err
      )
    );
  };

  setInterval(tick, CHECK_INTERVAL_MS);
  tick();
}

module.exports = { setDb, sendWeeklyReminder, startWeeklyRefreshReminder };

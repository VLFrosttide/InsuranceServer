"use strict";
const { google } = require("googleapis");
const { ProcessEmail } = require("./ProcessEmail.js");
const {
  loadCredentials,
  accountSuffix,
  hasCredentials,
  clearTokens,
  loadTokens,
} = require("./secrets.js");
const Authorize = require("./Authorize.js");
const mailStore = require("./mailStore.js");
const { notifyEmailRead } = require("../Users/websocket.js");

let MailPhotos = [];

function CreateOauthClient(ClientID, ClientSecret, RedirectUri) {
  return new google.auth.OAuth2(ClientID, ClientSecret, RedirectUri);
}

const POLL_INTERVAL_MS = Number(process.env.MAIL_POLL_INTERVAL_MS) || 45000;

// The up-to-three Gmail inboxes polled by this server. Each maps to a distinct
// OAuth token set (see Mail/Authorize.js and Mail/secrets.js). Any label whose
// OAuth credentials are not configured is skipped, so the server runs fine with
// 1, 2, or 3 inboxes.
const ACCOUNT_LABELS = ["Account1", "Account2", "Account3"];

// Only poll the inboxes that actually have OAuth credentials configured. This
// lets the server run with any number of boxes between 1 and 3 and never throw
// for a box that was left unconfigured.
function configuredAccounts() {
  return ACCOUNT_LABELS.filter((account) =>
    hasCredentials(accountSuffix(account))
  );
}

async function listUnreadIds(gmail) {
  // `messages.list` is paginated (default maxResults is only 100). Fetch every
  // page so a large inbox backlog is not silently truncated to the first page.
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults: 500,
      pageToken: pageToken || undefined,
    });
    for (const m of res.data.messages || []) {
      if (m && m.id) ids.push(m.id);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// Processes all currently unread messages for one account's inbox.
async function processUnreadMessages(gmail, account) {
  // Taken before asking Gmail, so emails released (and re-marked unread) while
  // this sweep is in flight are not mistaken for read ones.
  const sweepStartedAt = Date.now();
  const unreadIds = await listUnreadIds(gmail);

  // Drop cards whose Gmail message is no longer unread (e.g. someone read it
  // directly in Gmail). Claimed emails are left alone: a worker has the form
  // open, and completing/releasing it is handled through the WebSocket flow.
  // Cancelling (release_email) marks the Gmail message unread again, so a
  // cancelled email keeps its card.
  pruneReadEmails(account, new Set(unreadIds), sweepStartedAt);

  for (const messageId of unreadIds) {
    // Unread messages stay "unread" in Gmail until a worker completes/ignores
    // them, so every poll returns the whole backlog again. Skip anything we
    // already hold in the mail store before paying for a full message fetch.
    if (mailStore.has(account, messageId)) continue;
    try {
      await ProcessEmail(gmail, messageId, account);
    } catch (err) {
      // One malformed/failed message must never abort the rest of the sweep.
      console.error(
        `Failed to process Gmail message "${messageId}" (${account}):`,
        err
      );
    }
  }
}

// Remove every stored, unclaimed email of `account` that is no longer in the
// inbox's unread set, and tell connected workers to drop its card. Emails a
// worker cancelled after this sweep started are skipped: they are being marked
// unread again and the Gmail list may predate that.
function pruneReadEmails(account, unreadIdSet, sweepStartedAt) {
  for (const { email, claimed, releasedAt } of mailStore.listByAccount(
    account
  )) {
    if (claimed || unreadIdSet.has(email.messageId)) continue;
    if (releasedAt >= sweepStartedAt) continue;
    mailStore.remove(email.messageId);
    try {
      notifyEmailRead(email);
    } catch (err) {
      console.error(
        `Failed to broadcast read email "${email.messageId}" (${account}):`,
        err
      );
    }
  }
}

// Google rejects a stale/revoked credential with one of these OAuth errors. In
// that case the stored tokens can never be refreshed, so the only recovery is
// to clear them and run the interactive consent flow again.
function isBrokenTokenError(err) {
  const message = (err && err.message) || String(err);
  return /invalid_grant|unauthorized_client|invalid_client/.test(message);
}

// Authorize an inbox and validate its tokens by fetching the Gmail profile.
// If PRE-EXISTING stored tokens were rejected, clear them once and re-run
// authorization so a bad/stale token set never permanently disables the
// inbox.
//
// Important: this "clear and retry" recovery must only kick in for tokens
// that were already sitting in `.env` *before* this attempt (e.g. a revoked
// or expired refresh token left over from a previous run). If the tokens
// were instead obtained moments ago in THIS same call via the interactive
// consent flow, clearing them would delete the user's freshly completed
// authorization from `.env` and silently restart the interactive flow a
// second time — whose authorization code is a one-time code, so the first
// code is already spent and the retry fails too, leaving the account
// skipped with its tokens wiped. (This is exactly the bug where
// GMAIL_ACCESS_TOKEN_3/GMAIL_REFRESH_TOKEN_3/etc. disappeared from `.env`
// right after completing the consent flow for Account3.) We therefore only
// clear+retry when tokens already existed before the attempt; otherwise the
// real error is surfaced so the actual problem (wrong CLIENT_ID/CLIENT_SECRET,
// Gmail API not enabled, declined/insufficient scopes, etc.) can be diagnosed
// without losing the tokens that are already safely persisted in `.env`.
async function authorizeAccount(account) {
  const suffix = accountSuffix(account);
  const { clientId, clientSecret, redirectUri } = loadCredentials(suffix);

  const attempt = async () => {
    const hadStoredTokensBefore = Boolean(loadTokens(suffix));
    const OAuthClient = CreateOauthClient(clientId, clientSecret, redirectUri);
    try {
      await Authorize(OAuthClient, account, redirectUri);
      const gmail = google.gmail({ version: "v1", auth: OAuthClient });
      const Profile = await gmail.users.getProfile({ userId: "me" });
      return { gmail, email: Profile.data.emailAddress };
    } catch (err) {
      err.__insHadStoredTokens = hadStoredTokensBefore;
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isBrokenTokenError(err)) throw err;

    if (!err.__insHadStoredTokens) {
      // Nothing was stored beforehand for this attempt to "fall back" from —
      // the rejected tokens are the ones just minted by the interactive flow.
      // Leave them in `.env` and surface the real error instead of looping
      // into a second, likely-doomed consent flow.
      throw err;
    }

    console.warn(
      `Stored Gmail tokens for "${account}" were rejected (${err.message}). ` +
        `Clearing them and starting interactive authorization.`
    );
    clearTokens(suffix);
    return attempt();
  }
}

/**
 * Initialize the Gmail integration. This is called dynamically from main.js
 * so the REST + WebSocket server can start immediately even if OAuth fails.
 */
async function init() {
  const accounts = configuredAccounts();
  if (accounts.length === 0) {
    console.log(
      "No Gmail accounts configured (CLIENT_ID/CLIENT_SECRET missing). Skipping Gmail polling."
    );
    mailStore.markGmailReady();
    return;
  }

  // Phase 1: authorize and register EVERY inbox before any (potentially slow)
  // initial sweep runs, so replies can be sent as soon as possible after a
  // restart. Waiting requests (see SendReply.js) are released once this ends.
  const ready = [];
  try {
    for (const account of accounts) {
      try {
        ready.push({ account, gmail: await registerAccount(account) });
      } catch (err) {
        // One misconfigured inbox should never take down the others.
        console.warn(
          `Skipping Gmail account "${account}": ${
            err && err.message ? err.message : err
          }`
        );
      }
    }
  } finally {
    mailStore.markGmailReady();
  }

  // Phase 2: initial sweep + continuous polling per registered inbox.
  for (const { account, gmail } of ready) {
    try {
      await startPolling(gmail, account);
    } catch (err) {
      console.warn(
        `Initial Gmail sweep failed for "${account}": ${
          err && err.message ? err.message : err
        }`
      );
    }
  }
}

async function registerAccount(account) {
  const { gmail, email } = await authorizeAccount(account);
  console.log(`Profile log (${account}): `, email);

  // Register this inbox's client so completion can mark the message read
  // and replies can be sent against the correct account.
  mailStore.setGmail(account, gmail);
  return gmail;
}

async function startPolling(gmail, account) {
  // Initial sweep for anything that arrived while the server was offline.
  // A failure here must not prevent the interval below from being set up.
  try {
    await processUnreadMessages(gmail, account);
  } catch (err) {
    console.error(
      `Error during initial Gmail sweep (${account}) for unread messages:`,
      err
    );
  }

  // Continuously poll this inbox so newly arriving unread emails are picked
  // up and broadcast to connected Electron clients.
  let polling = false;
  setInterval(async () => {
    // If a sweep is still running (e.g. a large backlog of new messages with
    // attachments took longer than one interval), skip this tick instead of
    // stacking a second, overlapping sweep on top of it.
    if (polling) return;
    polling = true;
    try {
      await processUnreadMessages(gmail, account);
    } catch (err) {
      console.error(
        `Error while polling Gmail (${account}) for unread messages:`,
        err
      );
    } finally {
      polling = false;
    }
  }, POLL_INTERVAL_MS);
}

module.exports = { init, MailPhotos };

"use strict";
const { google } = require("googleapis");
const { ProcessEmail } = require("./ProcessEmail.js");
const {
  loadCredentials,
  accountSuffix,
  hasCredentials,
  clearTokens,
} = require("./secrets.js");
const Authorize = require("./Authorize.js");
const mailStore = require("./mailStore.js");

let MailPhotos = [];

function CreateOauthClient(ClientID, ClientSecret, RedirectUri) {
  return new google.auth.OAuth2(ClientID, ClientSecret, RedirectUri);
}

const POLL_INTERVAL_MS = Number(process.env.MAIL_POLL_INTERVAL_MS) || 30000;

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
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
  });
  return (res.data.messages || []).map((m) => m.id);
}

// Processes all currently unread messages for one account's inbox.
async function processUnreadMessages(gmail, account) {
  const unreadIds = await listUnreadIds(gmail);
  for (const messageId of unreadIds) {
    await ProcessEmail(gmail, messageId, account);
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
// If the stored tokens were rejected, clear them once and re-run authorization
// so a bad/placeholder token set never permanently disables the inbox.
async function authorizeAccount(account) {
  const suffix = accountSuffix(account);
  const { clientId, clientSecret, redirectUri } = loadCredentials(suffix);

  const withProfile = async () => {
    const OAuthClient = CreateOauthClient(clientId, clientSecret, redirectUri);
    await Authorize(OAuthClient, account, redirectUri);
    const gmail = google.gmail({ version: "v1", auth: OAuthClient });
    const Profile = await gmail.users.getProfile({ userId: "me" });
    return { gmail, email: Profile.data.emailAddress };
  };

  try {
    return await withProfile();
  } catch (err) {
    if (!isBrokenTokenError(err)) throw err;

    console.warn(
      `Stored Gmail tokens for "${account}" were rejected (${err.message}). ` +
        `Clearing them and starting interactive authorization.`
    );
    clearTokens(suffix);
    return withProfile();
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
    return;
  }

  for (const account of accounts) {
    try {
      await initAccount(account);
    } catch (err) {
      // One misconfigured inbox should never take down the others.
      console.warn(
        `Skipping Gmail account "${account}": ${
          err && err.message ? err.message : err
        }`
      );
    }
  }
}

async function initAccount(account) {
  const { gmail, email } = await authorizeAccount(account);
  console.log(`Profile log (${account}): `, email);

  // Register this inbox's client so completion can mark the message read
  // against the correct account.
  mailStore.setGmail(account, gmail);

  // Initial sweep for anything that arrived while the server was offline.
  await processUnreadMessages(gmail, account);

  // Continuously poll this inbox so newly arriving unread emails are picked
  // up and broadcast to connected Electron clients.
  setInterval(async () => {
    try {
      await processUnreadMessages(gmail, account);
    } catch (err) {
      console.error(
        `Error while polling Gmail (${account}) for unread messages:`,
        err
      );
    }
  }, POLL_INTERVAL_MS);
}

module.exports = { init, MailPhotos };

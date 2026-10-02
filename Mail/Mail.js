"use strict";
const { google } = require("googleapis");
const { ProcessEmail } = require("./ProcessEmail.js");
const { loadCredentials } = require("./secrets.js");
const Authorize = require("./Authorize.js");

let MailPhotos = [];

function CreateOauthClient(ClientID, ClientSecret, RedirectUri) {
  return new google.auth.OAuth2(ClientID, ClientSecret, RedirectUri);
}

const POLL_INTERVAL_MS = Number(process.env.MAIL_POLL_INTERVAL_MS) || 30000;

async function listUnreadIds(gmail) {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
  });
  return (res.data.messages || []).map((m) => m.id);
}

// Processes all currently unread messages for the connected inbox.
async function processUnreadMessages(gmail) {
  const unreadIds = await listUnreadIds(gmail);
  for (const messageId of unreadIds) {
    await ProcessEmail(gmail, messageId, "Account1");
  }
}

/**
 * Initialize the Gmail integration. This is called dynamically from main.js
 * so the REST + WebSocket server can start immediately even if OAuth fails.
 */
async function init() {
  const { clientId, clientSecret, redirectUri } = loadCredentials();

  const OAuthClient = await Authorize(
    CreateOauthClient(clientId, clientSecret, redirectUri),
    "Account1",
    redirectUri
  );

  const gmail = google.gmail({ version: "v1", auth: OAuthClient });
  const Profile = await gmail.users.getProfile({ userId: "me" });
  console.log("Profile log: ", Profile.data.emailAddress);
  const Email = Profile.data.emailAddress;
  console.log("Email log: ", Email);

  // Initial sweep for anything that arrived while the server was offline.
  await processUnreadMessages(gmail);

  // Continuously poll the inbox so newly arriving unread emails are picked up
  // and broadcast to connected Electron clients.
  setInterval(async () => {
    try {
      await processUnreadMessages(gmail);
    } catch (err) {
      console.error("Error while polling Gmail for unread messages:", err);
    }
  }, POLL_INTERVAL_MS);
}

module.exports = { init, MailPhotos };

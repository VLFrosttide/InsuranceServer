const fs = require("node:fs");
const path = require("node:path");

// All OAuth credentials and Gmail tokens are supplied exclusively through the
// .env file (which is gitignored). Nothing in this file contains raw values.
const ENV_PATH = path.resolve(process.cwd(), ".env");

// Maps OAuth token fields to their corresponding .env variable names.
const TOKEN_ENV_KEYS = {
  access_token: "GMAIL_ACCESS_TOKEN",
  refresh_token: "GMAIL_REFRESH_TOKEN",
  scope: "GMAIL_SCOPE",
  token_type: "GMAIL_TOKEN_TYPE",
  expiry_date: "GMAIL_EXPIRY_DATE",
};

module.exports.loadCredentials = function loadCredentials() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const redirectUri = process.env.REDIRECT_URI || "http://localhost:3000";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing OAuth credentials. Set CLIENT_ID and CLIENT_SECRET in .env"
    );
  }

  return { clientId, clientSecret, redirectUri };
};

module.exports.loadTokens = function loadTokens() {
  const tokens = {};

  if (process.env.GMAIL_ACCESS_TOKEN) {
    tokens.access_token = process.env.GMAIL_ACCESS_TOKEN;
  }
  if (process.env.GMAIL_REFRESH_TOKEN) {
    tokens.refresh_token = process.env.GMAIL_REFRESH_TOKEN;
  }
  if (process.env.GMAIL_SCOPE) {
    tokens.scope = process.env.GMAIL_SCOPE;
  }
  if (process.env.GMAIL_TOKEN_TYPE) {
    tokens.token_type = process.env.GMAIL_TOKEN_TYPE;
  }
  if (process.env.GMAIL_EXPIRY_DATE) {
    tokens.expiry_date = Number(process.env.GMAIL_EXPIRY_DATE);
  }

  return Object.keys(tokens).length > 0 ? tokens : null;
};

// Writes refreshed/updated tokens back into the .env file so tokens only ever
// live in .env (never in source control). Existing comments are preserved.
module.exports.persistTokens = function persistTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return;
  if (!fs.existsSync(ENV_PATH)) return;

  const updates = {};
  for (const [tokenKey, envKey] of Object.entries(TOKEN_ENV_KEYS)) {
    const value = tokens[tokenKey];
    if (value !== undefined && value !== null && value !== "") {
      updates[envKey] = String(value);
    }
  }
  if (Object.keys(updates).length === 0) return;

  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  const seen = new Set();

  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && updates[match[1]] !== undefined) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, updated.join("\n"));
};

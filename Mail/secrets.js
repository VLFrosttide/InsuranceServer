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

// Maps an account label to the trailing suffix used for its `.env` variables.
// Account1 keeps the base names; Account2/Account3 append `_2`/`_3`.
module.exports.accountSuffix = function accountSuffix(account) {
  if (account === "Account2") return "_2";
  if (account === "Account3") return "_3";
  return "";
};

// Each Gmail inbox uses its own OAuth client, so `CLIENT_ID`/`CLIENT_SECRET`
// are likewise account-specific. Account1 reads the base names; Account2/3
// read the `_2`/`_3` variants. The redirect URI defaults to the shared value
// but can also be overridden per account.
module.exports.hasCredentials = function hasCredentials(suffix = "") {
  const clientId = process.env["CLIENT_ID" + suffix];
  const clientSecret = process.env["CLIENT_SECRET" + suffix];
  return Boolean(clientId && clientSecret);
};

module.exports.loadCredentials = function loadCredentials(suffix = "") {
  const clientId = process.env["CLIENT_ID" + suffix];
  const clientSecret = process.env["CLIENT_SECRET" + suffix];
  const redirectUri =
    process.env["REDIRECT_URI" + suffix] ||
    process.env.REDIRECT_URI ||
    "http://localhost:3000";

  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing OAuth credentials. Set CLIENT_ID${suffix} and CLIENT_SECRET${suffix} in .env`
    );
  }

  return { clientId, clientSecret, redirectUri };
};

// `suffix` selects which Gmail account inbox the tokens belong to. Account1
// uses the base `GMAIL_*` names (backwards compatible with existing `.env`
// files); Account2/Account3 append `_2`/`_3` (e.g. `GMAIL_ACCESS_TOKEN_2`).
module.exports.loadTokens = function loadTokens(suffix = "") {
  const tokens = {};

  for (const [tokenKey, baseEnvKey] of Object.entries(TOKEN_ENV_KEYS)) {
    const value = process.env[baseEnvKey + suffix];
    if (value !== undefined && value !== "") {
      tokens[tokenKey] = tokenKey === "expiry_date" ? Number(value) : value;
    }
  }

  return Object.keys(tokens).length > 0 ? tokens : null;
};

// Writes refreshed/updated tokens back into the .env file so tokens only ever
// live in .env (never in source control). Existing comments are preserved.
module.exports.persistTokens = function persistTokens(tokens, suffix = "") {
  if (!tokens || typeof tokens !== "object") return;
  if (!fs.existsSync(ENV_PATH)) return;

  const updates = {};
  for (const [tokenKey, envKey] of Object.entries(TOKEN_ENV_KEYS)) {
    const value = tokens[tokenKey];
    if (value !== undefined && value !== null && value !== "") {
      updates[envKey + suffix] = String(value);
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

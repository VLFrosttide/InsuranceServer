const { SCOPES } = require("./constants.js");
const { loadTokens, persistTokens, accountSuffix } = require("./secrets.js");
const obtainAuthCode = require("./ObtainCode.js");

async function Authorize(MyClient, Account, RedirectUri) {
  // Each account keeps its tokens under `GMAIL_*` (Account1) or a suffixed
  // variant (`GMAIL_*_2`/`GMAIL_*_3`), all read from the environment (.env).
  const suffix = accountSuffix(Account);
  const existing = loadTokens(suffix);
  if (existing) {
    MyClient.setCredentials(existing);
    MyClient.on("tokens", (fresh) => {
      persistTokens({ ...existing, ...fresh }, suffix);
    });
    console.log("Using an existing token for account: " + Account);
    return MyClient;
  }

  // The consent flow is interactive: it prints a URL and waits for a code on
  // stdin. On non-interactive hosting (no TTY) that wait would hang forever,
  // so fail fast with an actionable message instead.
  if (!process.stdin.isTTY) {
    throw new Error(
      `No tokens stored for "${Account}" and no interactive terminal is ` +
        `available to complete Google OAuth. Run the authorization once ` +
        `locally so tokens are written to .env, or provide valid GMAIL_*` +
        `${suffix} values.`
    );
  }

  const AuthUrl = MyClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    redirect_uri: RedirectUri,
  });

  console.log(
    `\nAuthorize Gmail for account label "${Account}" by visiting:\n`
  );
  console.log(AuthUrl);
  console.log(
    "\nPick the Gmail inbox that should map to this label in the account chooser."
  );
  console.log(
    'After approving, the tab should say "Auth complete". If it does not,'
  );
  console.log("paste the full redirect URL (or just the code= value) below.\n");

  // Wait for the browser to send back the authorization code (or for the
  // user to paste it), then exchange it for access/refresh tokens.
  const code = await obtainAuthCode(RedirectUri);
  const result = await MyClient.getToken(code);
  const tokens = result.tokens || result;

  MyClient.setCredentials(tokens);
  persistTokens(tokens, suffix);
  MyClient.on("tokens", (fresh) => {
    persistTokens({ ...tokens, ...fresh }, suffix);
  });
  console.log(
    "Authorization complete and tokens stored for account: " + Account
  );

  return MyClient;
}

module.exports = Authorize;

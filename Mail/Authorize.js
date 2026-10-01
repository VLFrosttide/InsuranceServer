import { SCOPES } from "./constants.js";
import { loadTokens, persistTokens } from "./secrets.js";
import obtainAuthCode from "./ObtainCode.js";

async function Authorize(MyClient, Account, RedirectUri) {
  // Tokens are read from the environment (.env), not from a tracked file.
  const existing = loadTokens();
  if (existing) {
    MyClient.setCredentials(existing);
    MyClient.on("tokens", (fresh) => {
      persistTokens({ ...existing, ...fresh });
    });
    console.log("Using an existing token for account: " + Account);
    return MyClient;
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
  persistTokens(tokens);
  MyClient.on("tokens", (fresh) => {
    persistTokens({ ...tokens, ...fresh });
  });
  console.log(
    "Authorization complete and tokens stored for account: " + Account
  );

  return MyClient;
}

export default Authorize;

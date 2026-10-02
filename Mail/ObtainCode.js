const readline = require("node:readline");
const http = require("node:http");

function extractCode(value) {
  // Support pasting the full redirect URL or just the raw code.
  if (!value) return "";
  let code = value;

  try {
    const url = new URL(value);
    if (url.searchParams.has("code")) {
      code = url.searchParams.get("code");
    } else if (url.searchParams.has("?code")) {
      code = url.searchParams.get("?code");
    }
  } catch {
    // Not a URL, treat as a raw code.
  }

  const keyMatch = code.match(/(?:^|[?&])code=([^&]+)/);
  if (keyMatch) code = keyMatch[1];

  return decodeURIComponent(code.trim());
}

function obtainAuthCode(redirectUri) {
  let redirect = null;
  try {
    redirect = new URL(redirectUri);
  } catch (err) {
    console.error("Error redirecting: ", err);
    /* fall back to paste */
  }
  const canListen =
    redirect &&
    redirect.protocol === "http:" &&
    (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1");

  return new Promise((resolve, reject) => {
    let settled = false;
    let server = null;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const done = (err, code) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (server) {
        server.close();
        server.closeAllConnections?.();
      }
      if (err) reject(err);
      else resolve(code);
    };

    rl.question("Redirect URL or code: ", (answer) => {
      const pasted = String(answer || "").trim();
      if (!pasted) {
        if (!server) done(new Error("No authorization code provided"));
        return;
      }
      try {
        done(null, extractCode(pasted));
      } catch (err) {
        done(err);
      }
    });

    if (!canListen) return;

    const port = Number(redirect.port || 80);
    const expectedPath = redirect.pathname || "/";

    server = http.createServer((req, res) => {
      res.setHeader("Connection", "close");
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      if (expectedPath !== "/" && reqUrl.pathname !== expectedPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const oauthError = reqUrl.searchParams.get("error");
      if (oauthError) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`OAuth error: ${oauthError}`);
        done(new Error(`OAuth error from Google: ${oauthError}`));
        return;
      }
      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing code parameter");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h2>Auth complete.</h2><p>You can close this tab.</p></body></html>"
      );
      process.stdout.write("\n(Received code from browser.)\n");
      done(null, code);
    });

    server.on("error", (err) => {
      console.log(
        `\n(Could not listen on port ${port}: ${
          err.code || err.message
        } — paste the redirect URL instead.)`
      );
      server = null;
    });

    server.listen(port, "127.0.0.1");
  });
}

module.exports = obtainAuthCode;

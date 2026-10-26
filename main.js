"use strict";
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("http");
const mysql = require("mysql2/promise");
const { createLoginRouter } = require("./Requests/LoginReq.js");
const { createRegRouter } = require("./Requests/RegReq.js");
const { createAccountRouter } = require("./Requests/Account.js");
const { createTierRouter } = require("./Requests/TierEndpoints.js");
const { createCurrentCashRouter } = require("./Requests/CurrentCash.js");
const { createCardPaymentsRouter } = require("./Requests/CardPayments.js");
const { createBrokerRouter } = require("./Requests/Brokers.js");
const { createTariffsRouter } = require("./Requests/Tariffs.js");
const { createReportsRouter } = require("./Requests/Reports.js");
const { createTestRouter } = require("./Requests/Test.js");
const { initWsServer } = require("./Users/websocket.js");
const { runSetup } = require("./db/setup.js");

// ---------------------------------------------------------------------------
// Optional .env loading.
//
// Local development traditionally used `node --env-file=.env main.js`. That
// flag is not guaranteed to be used on shared Node.js hosting (the platform
// often runs the entry file directly). Load `.env` manually when present, but
// NEVER override a variable already set in the real environment so hosting
// platforms can inject secrets such as DB_PASSWORD and PORT.
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // `.env` is optional. The host may provide all configuration directly.
  }
}
// Look for `.env` in several places so the same entry point works both in the
// source tree (`node main.js`) and as a packaged executable. Inside a packaged
// binary `__dirname` points into the embedded snapshot, so also check the
// process working directory and the directory the executable lives in.
const ENV_CANDIDATES = [
  path.join(__dirname, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(path.dirname(process.execPath), ".env"),
];
const envFile = ENV_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});
if (envFile) loadEnvFile(envFile);

const app = express();
const httpServer = http.createServer(app);

// Keep long-lived keep-alive connections alive across a reverse proxy/CDN that
// closes idle sockets around the 60s mark. headersTimeout must stay above
// keepAliveTimeout. This avoids spurious 502/504 responses on slow keep-alive
// connections — a common cause of intermittent "can't log in" reports.
httpServer.keepAliveTimeout = 65 * 1000;
httpServer.headersTimeout = 66 * 1000;

let DBConnection = null;

// Start timestamp for uptime reporting in /health and /ping.
const SERVER_STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// In-memory diagnostic rings. Kept small on purpose: they let an operator
// inspect what was failing during an incident window (e.g. a daily 13:00-17:00
// login outage) without a separate log dashboard.
// ---------------------------------------------------------------------------
const RECENT_REQUESTS_LIMIT = 500;
const RECENT_FAILURES_LIMIT = 100;
const recentRequests = [];
const recentFailures = [];

function pushRing(items, item, limit) {
  items.push(item);
  if (items.length > limit) items.shift();
}

// Resolve the client's real IP address. The API sits behind a CDN/reverse
// proxy (Hostinger), so the originating address arrives in `X-Forwarded-For`
// (left-most value = client). Fall back to the raw socket address for direct
// connections (e.g. local development on 127.0.0.1).
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) {
    const ip = String(first).split(",")[0].trim();
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

// Never let a transient error (a rejected promise or an uncaught exception)
// take the whole process down during a network/DB blip. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ---------------------------------------------------------------------------
// Deployment-friendly configuration.
//
// Local defaults are preserved (MySQL on 127.0.0.1:5500, API on port 5501),
// but every value can be overridden through environment variables.
//
// Hostinger Node.js hosting provides `PORT` and expects the app to bind to
// 0.0.0.0. MySQL credentials/host/port/database must be supplied via env vars
// (or a `.env` file) because they differ from the local development machine.
// ---------------------------------------------------------------------------
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 5501;

const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "insurancedb",
  port: Number(process.env.DB_PORT) || 5500,
  connectTimeout: 5000,
  // Return DATE/DATETIME/TIMESTAMP columns as the exact stored strings instead
  // of JavaScript Date objects. DATETIME values such as insurance.CreationDate
  // hold the CLIENT's local wall-clock, so re-interpreting them through the
  // server or browser timezone shifts the calendar day around midnight. Strings
  // make the client -> DB -> website round-trip lossless.
  dateStrings: true,
};

function startGmailPolling() {
  // Gmail polling is optional and runs in the background. If OAuth isn't
  // configured / valid, or a sweep takes a long time, the REST + WebSocket
  // server still starts immediately so the app can be tested.
  // Set DISABLE_GMAIL=1 to skip it entirely (e.g. automated tests).
  if (process.env.DISABLE_GMAIL === "1") {
    console.log("Gmail integration disabled via DISABLE_GMAIL=1.");
    require("./Mail/mailStore.js").markGmailReady();
    return;
  }

  Promise.resolve()
    .then(() => require("./Mail/Mail.js"))
    .then((mail) => mail.init())
    .catch((err) => {
      console.warn(
        `Gmail integration disabled: ${err.message || err}. ` +
          "The API and WebSocket server will still run."
      );
    })
    .finally(() => {
      // Never leave reply requests waiting on an integration that is not
      // coming up (init normally marks readiness itself).
      require("./Mail/mailStore.js").markGmailReady();
    });
}

async function start() {
  // Accept large JSON bodies (up to 50 MB) so the Electron client can send
  // dropped files as base64 data along with the insurance form.
  app.use(express.json({ limit: "50mb" }));

  // CORS: the Electron client loads from file:// and calls this server on
  // http://127.0.0.1:5501. Allow JSON + Bearer-token requests across origins.
  app.use((req, res, next) => {
    // Every response from this API is dynamic (auth, balances, live email
    // state). The site sits behind Hostinger's CDN, which will otherwise store
    // whatever it sees - including a transient error page generated at the edge
    // while this process restarts. `no-store` keeps the CDN from ever serving a
    // stale response for these routes.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // Request access log + failure capture. Every request is logged with its
  // duration and status, so the server's own log can be correlated against a
  // reported outage window (e.g. the daily 13:00-17:00 login failures).
  // Failures are also kept in an in-memory ring surfaced by /health.
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Math.round(
        Number(process.hrtime.bigint() - started) / 1e6
      );
      // `req.user` is attached by the auth middleware before the response
      // finishes, so it is populated here for authenticated routes.
      const user = req.user && req.user.username ? req.user.username : null;
      const entry = {
        at: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs,
        ip: clientIp(req),
        user,
      };
      pushRing(recentRequests, entry, RECENT_REQUESTS_LIMIT);
      if (res.statusCode >= 400) {
        pushRing(recentFailures, entry, RECENT_FAILURES_LIMIT);
      }
      console.log(
        `[request] ${entry.method} ${entry.path} -> ${entry.status} ` +
          `(${entry.durationMs}ms) ip=${entry.ip}` +
          (entry.user ? ` user=${entry.user}` : "")
      );
    });
    next();
  });

  // Create the connection pool immediately. A pool does not open a socket
  // until the first query, so mounting routes and binding the HTTP server is
  // never blocked by MySQL availability. Endpoints stay registered even when
  // the database is temporarily unreachable (they then surface a real DB
  // error instead of a misleading Express 404).
  const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    // Recycle connections that have sat idle for a minute. A connection the
    // MySQL server dropped (e.g. during a nightly maintenance/backup window) is
    // discarded and transparently replaced on the next query, instead of being
    // handed to a login attempt that then fails.
    idleTimeout: 60 * 1000,
  });

  // Transaction helper: run a sequence of statements on one dedicated
  // connection and atomically roll back on failure. Simple queries may still
  // use `pool.query(...)` directly (transparent connection reuse).
  pool.withTransaction = async function withTransaction(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // Ignore rollback errors; the original error is more useful.
      }
      throw err;
    } finally {
      conn.release();
    }
  };

  DBConnection = pool;

  // Mount every router up front so its routes are always available. The
  // routers only touch DBConnection at request time, so this is safe even
  // before the first successful database ping. This guarantees /logme (and
  // every other endpoint) never returns a bare 404 just because the MySQL
  // setup/verification below has not completed or failed.
  app.use(createLoginRouter(DBConnection));
  app.use(createRegRouter(DBConnection));
  app.use(createAccountRouter(DBConnection));
  app.use(createTierRouter(DBConnection));
  app.use(createCurrentCashRouter(DBConnection));
  app.use(createCardPaymentsRouter(DBConnection));
  app.use(createBrokerRouter(DBConnection));
  app.use(createTariffsRouter(DBConnection));
  app.use(createReportsRouter(DBConnection));
  app.use(createTestRouter(DBConnection));

  // ---------------------------------------------------------------------------
  // Serve the InsuranceWebsite frontend from this same server so the API and
  // the website share one origin (no separate static deployment, no CORS gap).
  //
  // The web root is configurable via WEB_DIR. By default it uses the sibling
  // "InsuranceWebsite" directory (the normal local layout), and falls back to a
  // bundled "public" folder when this server is deployed standalone. Only the
  // statically-available files are served - there is no catch-all fallback, so
  // the API routers above always take precedence.
  // ---------------------------------------------------------------------------
  const WEB_DIR =
    process.env.WEB_DIR ||
    (fs.existsSync(path.join(__dirname, "..", "InsuranceWebsite"))
      ? path.join(__dirname, "..", "InsuranceWebsite")
      : path.join(__dirname, "public"));

  if (fs.existsSync(WEB_DIR)) {
    app.use(express.static(WEB_DIR));
    console.log(`Serving website from ${WEB_DIR}`);
  } else {
    console.warn(
      `Website directory not found (${WEB_DIR}). The static site is not ` +
        "served. Set WEB_DIR or place the InsuranceWebsite files in a matching folder."
    );
  }

  // Live state used by /health. It becomes true (or false again) after each
  // database ping, so /health reflects the current state, not just startup.
  let dbHealthy = false;

  // Lightweight liveness probe that never touches MySQL. Client-side network
  // monitors poll this to measure reachability/latency without loading the DB.
  app.get("/ping", (req, res) => {
    res.json({
      status: "ok",
      service: "InsuranceServer",
      time: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
    });
  });

  // Readiness probe. Pings the database live so it also detects a database
  // that became unreachable after boot, and reports the round-trip time plus a
  // snapshot of the most recent failed requests for correlation.
  app.get("/health", async (req, res) => {
    let dbLatencyMs = null;
    let dbError = null;
    try {
      const started = Date.now();
      const conn = await pool.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
      dbLatencyMs = Date.now() - started;
      dbHealthy = true;
    } catch (err) {
      dbHealthy = false;
      dbError = err && err.message ? err.message : String(err);
      pushRing(
        recentFailures,
        {
          at: new Date().toISOString(),
          method: "HEALTH",
          path: "/health",
          status: 503,
          durationMs: null,
          error: dbError,
        },
        RECENT_FAILURES_LIMIT
      );
    }

    const body = {
      status: dbHealthy ? "ok" : "degraded",
      service: "InsuranceServer",
      time: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      dbHealthy,
      dbLatencyMs,
      ...(dbError ? { dbError } : {}),
      recentFailures: recentFailures.slice(-20),
    };
    return res.status(dbHealthy ? 200 : 503).json(body);
  });

  // Plain-HTTP probe for the WebSocket route. The upgrade itself cannot be
  // exercised from a browser address bar or curl, and Express' HTML
  // "Cannot GET /ws" is indistinguishable from "this route does not exist"
  // while diagnosing a reverse proxy. Answering with JSON proves the request
  // reached this process - exactly what needs to be known when a client
  // reports a failed handshake (e.g. a 3xx produced by the CDN in front).
  app.get("/ws", (req, res) => {
    res.json({
      status: "ok",
      service: "InsuranceServer",
      upgrade: "websocket",
      hint: "Send 'Connection: Upgrade' + 'Upgrade: websocket' to this path.",
    });
  });

  // Bind the socket immediately. Hostinger's startup watchdog requires
  // `listen()` to be called within a few seconds, so it must never be gated
  // behind the (potentially slow) database setup below.
  httpServer.listen(PORT, HOST);

  // Attach the WebSocket server unconditionally. The handshake must succeed
  // even while MySQL is unreachable: the app degrades gracefully, but a failed
  // upgrade that is never handled leaves the reverse proxy with nothing to
  // forward, so it answers the client with a 504 instead of a clean close.
  // Auth queries run lazily on the "auth" message, so the DB pool is only
  // touched once a client actually authenticates.
  initWsServer(httpServer, DBConnection);

  try {
    // Ensure the schema exists BEFORE the pool is verified. `runSetup` creates
    // the database when it is missing, so running it first lets a brand-new
    // (deployed) database be created and its schema brought up to date. It is
    // also idempotent, so it is safe to call on every start. Any failure is
    // non-fatal here: the code below still attempts the pool connection so the
    // server can report a degraded /health instead of crashing.
    try {
      await runSetup({
        host: DB_CONFIG.host,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
        database: DB_CONFIG.database,
        port: DB_CONFIG.port,
      });
      console.log("Database schema is ready.");
    } catch (setupErr) {
      console.warn(
        "Database setup skipped:",
        setupErr && setupErr.message ? setupErr.message : setupErr
      );
    }

    // Verify we can actually reach MySQL. The pool itself handles reconnects
    // at runtime; this check only drives the /health readiness signal.
    {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    }

    dbHealthy = true;
    console.log("Connected to MySQL database.");

    // Let the mail pipeline check senders against the broker emails in the DB.
    require("./Mail/brokerSenders.js").setDb(DBConnection);
    // Let the Gmail token-refresh reminder persist its last-sent Saturday in
    // the DB so a restart on the same Saturday does not send a duplicate.
    require("./Mail/renewalReminder.js").setDb(DBConnection);
    startGmailPolling();

    // Durable email retry queue: replies that fail to send through the Gmail
    // API are persisted here and retried in the background with backoff (and
    // across restarts) instead of being silently lost.
    require("./Mail/emailOutbox.js").setDb(DBConnection);
    require("./Mail/emailOutbox.js").start();

    console.log(`Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error(
      "Failed to connect to MySQL database.",
      err && err.message ? err.message : err
    );
    console.error(
      `Target database: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`
    );
    console.error(
      "Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME environment " +
        "variables (or create a .env file) and restart. The HTTP server stays " +
        "up in a degraded state so /health can be reached; routes remain " +
        "registered and return a real error instead of a JSON 404."
    );

    // Gmail polling is not started without a database; release any reply
    // request waiting for it so it fails fast with a clear error.
    require("./Mail/mailStore.js").markGmailReady();

    console.log(`Server listening on http://${HOST}:${PORT} (degraded)`);
  }
}

module.exports = {
  app,
  start,
  get DBConnection() {
    return DBConnection;
  },
};

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exitCode = 1;
});

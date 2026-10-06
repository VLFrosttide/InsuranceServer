"use strict";
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("http");
const mysql = require("mysql2/promise");
const { createLoginRouter } = require("./Requests/LoginReq.js");
const { createRegRouter } = require("./Requests/RegReq.js");
const { createTierRouter } = require("./Requests/TierEndpoints.js");
const { createCurrentCashRouter } = require("./Requests/CurrentCash.js");
const { createCardPaymentsRouter } = require("./Requests/CardPayments.js");
const { createBrokerRouter } = require("./Requests/Brokers.js");
const { createTariffsRouter } = require("./Requests/Tariffs.js");
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

let DBConnection = null;

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
};

function startGmailPolling() {
  // Gmail polling is optional and runs in the background. If OAuth isn't
  // configured / valid, or a sweep takes a long time, the REST + WebSocket
  // server still starts immediately so the app can be tested.
  // Set DISABLE_GMAIL=1 to skip it entirely (e.g. automated tests).
  if (process.env.DISABLE_GMAIL === "1") {
    console.log("Gmail integration disabled via DISABLE_GMAIL=1.");
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
    });
}

async function start() {
  // Accept large JSON bodies (up to 50 MB) so the Electron client can send
  // dropped files as base64 data along with the insurance form.
  app.use(express.json({ limit: "50mb" }));

  // CORS: the Electron client loads from file:// and calls this server on
  // http://127.0.0.1:5501. Allow JSON + Bearer-token requests across origins.
  app.use((req, res, next) => {
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

  // Create the connection pool immediately. A pool does not open a socket
  // until the first query, so mounting routes and binding the HTTP server is
  // never blocked by MySQL availability. Endpoints stay registered even when
  // the database is temporarily unreachable (they then surface a real DB
  // error instead of a misleading Express 404).
  const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
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
  app.use(createTierRouter(DBConnection));
  app.use(createCurrentCashRouter(DBConnection));
  app.use(createCardPaymentsRouter(DBConnection));
  app.use(createBrokerRouter(DBConnection));
  app.use(createTariffsRouter(DBConnection));
  app.use(createTestRouter(DBConnection));

  // Live state used by /health. It becomes true only after a successful
  // database ping, so /health accurately reports degraded vs. ready.
  let dbHealthy = false;

  app.get("/health", (req, res) => {
    if (dbHealthy) {
      return res.json({ status: "ok", service: "InsuranceServer" });
    }
    return res
      .status(503)
      .json({ status: "degraded", error: "Database unavailable" });
  });

  // Bind the socket immediately. Hostinger's startup watchdog requires
  // `listen()` to be called within a few seconds, so it must never be gated
  // behind the (potentially slow) database setup below.
  httpServer.listen(PORT, HOST);

  try {
    // Ensure the schema and seed/test data exist BEFORE the pool is verified.
    // `runSetup` creates the database when it is missing, so running it first
    // lets a brand-new (deployed) database be created and seeded. It is also
    // idempotent, so it is safe to call on every start. Any seed failure is
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
      console.log("Database schema and test data are ready.");
    } catch (seedErr) {
      console.warn(
        "Database auto-seed skipped:",
        seedErr && seedErr.message ? seedErr.message : seedErr
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

    initWsServer(httpServer, DBConnection);
    // Let the mail pipeline check senders against the broker emails in the DB.
    require("./Mail/brokerSenders.js").setDb(DBConnection);
    startGmailPolling();

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

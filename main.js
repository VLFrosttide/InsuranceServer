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
const { initWsServer } = require("./Users/websocket.js");

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
loadEnvFile(path.join(__dirname, ".env"));

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
  app.use(express.json());

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

  // Start the HTTP listener immediately. Hostinger's startup watchdog requires
  // `listen()` to be called within a few seconds, so it must never be gated
  // behind the (potentially slow or failing) database connection below.
  httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });

  try {
    // Use a pool instead of a single connection. A single connection can be
    // closed by the MySQL server (idle timeout / network drop) and the app had
    // no way to recover from that, producing errors such as
    // "Can't add new command when connection is in closed state".
    const pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });

    DBConnection = pool;

    // Verify we can actually reach MySQL before wiring up the routers. This
    // keeps the same "degraded /health" behavior we had with a single
    // connection, while the pool itself handles reconnects at runtime.
    {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    }

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

    app.use(createLoginRouter(DBConnection));
    app.use(createRegRouter(DBConnection));
    app.use(createTierRouter(DBConnection));
    app.use(createCurrentCashRouter(DBConnection));
    app.use(createCardPaymentsRouter(DBConnection));
    app.use(createBrokerRouter(DBConnection));

    initWsServer(httpServer, DBConnection);
    startGmailPolling();

    console.log("Connected to MySQL database.");
  } catch (err) {
    if (DBConnection) {
      try {
        await DBConnection.end();
      } catch {
        // Ignore shutdown errors during the connection-failure path.
      }
    }
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
        "up in a degraded state so /health can be reached."
    );

    // Expose a degraded health endpoint instead of crashing before listen().
    app.get("/health", (req, res) => {
      res
        .status(503)
        .json({ status: "degraded", error: "Database unavailable" });
    });
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

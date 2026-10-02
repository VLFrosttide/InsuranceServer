"use strict";
const express = require("express");
const http = require("http");
const mysql = require("mysql2/promise");
const { createLoginRouter } = require("./Requests/LoginReq.js");
const { createRegRouter } = require("./Requests/RegReq.js");
const { createTierRouter } = require("./Requests/TierEndpoints.js");
const { initWsServer } = require("./Users/websocket.js");

const app = express();
const httpServer = http.createServer(app);

let DBConnection = null;

async function start() {
  DBConnection = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password: process.env.DB_PASSWORD,
    database: "insurancedb",
    port: 5500,
  });

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

  app.use(createLoginRouter(DBConnection));
  app.use(createRegRouter(DBConnection));
  app.use(createTierRouter(DBConnection));

  initWsServer(httpServer, DBConnection);

  // Gmail polling is optional and runs in the background. If OAuth isn't
  // configured / valid, or a sweep takes a long time, the REST + WebSocket
  // server still starts immediately so the app can be tested.
  // Set DISABLE_GMAIL=1 to skip it entirely (e.g. automated tests).
  if (process.env.DISABLE_GMAIL === "1") {
    console.log("Gmail integration disabled via DISABLE_GMAIL=1.");
  } else {
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

  httpServer.listen(5501, "127.0.0.1", () => {
    console.log(`Server listening on http://127.0.0.1:5501`);
  });
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

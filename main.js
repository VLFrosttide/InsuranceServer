"use strict";
const express = require("express");
const app = express();
const port = process.env.PORT || 8080;
const http = require("http");
const path = require("path");
const httpServer = http.createServer(app);
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("./Database.db");

app.post("/", (req, res) => {
  res.send("Got a POST request");
});

app.get("/", (req, res) => {
  res.send("Server is running");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});

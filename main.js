"use strict";
const express = require("express");
const app = express();
const port = 443;
const http = require("http");
const path = require("path");
const httpServer = http.createServer(app);
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("./Database.db");

app.post("/", (req, res) => {
  res.send("Got a POST request");
});

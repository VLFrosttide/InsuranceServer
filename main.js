"use strict";
const express = require("express");
const app = express();
const port = 5500;
const http = require("http");
const path = require("path");
const httpServer = http.createServer(app);
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("./Database.db");

"use strict";
import express from "express";
import http from "http";
import mysql from "mysql2/promise";
import {LoginRouter} from "./Requests/LoginReq.js";
const app = express();
const httpServer = http.createServer(app);
let DBConnection = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: process.env.DBPassword,
  database: "insurancedb",
  port: 5500,
});

const [rows] = await DBConnection.execute("SELECT * FROM users");

console.log(rows);
app.use(express.json());
app.use((req, res, next) => {
 next();
});

app.use(LoginRouter);

httpServer.listen(5501, "127.0.0.1", () => {
  console.log(`Server listening on port ${5501}`);
});

export { app, DBConnection };

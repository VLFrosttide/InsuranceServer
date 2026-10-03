"use strict";
const express = require("express");
const Bcrypt = require("bcrypt");
const Crypto = require("crypto");

const ROLE_PAGES = {
  1: "/admin",
  2: "/worker",
  3: "/client",
};

/**
 * Login router factory. Receives the DB connection so it does not rely on a
 * circular import from main.js.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createLoginRouter = function createLoginRouter(DBConnection) {
  const router = express.Router();

  // Terse, structured logging for each login attempt and its final response.
  // The response is logged as a quick summary (status + message/error), never
  // the entire Express response object.
  function sendLoginResponse(res, status, body) {
    const summary = (body && (body.message || body.error)) || "";
    console.log(`Login response: ${status}${summary ? " - " + summary : ""}`);
    return res.status(status).json(body);
  }

  router.post("/logme", async (req, res) => {
    try {
      const Username = req.body["username"];
      const Password = req.body["password"];

      console.log(
        `Login attempt for user: ${Username || "(missing username)"}`
      );

      if (!Username || !Password) {
        return sendLoginResponse(res, 400, {
          error: "Username and Password are required",
        });
      }

      const [rows] = await DBConnection.query(
        "SELECT * FROM users WHERE Username = ?",
        [Username]
      );

      if (rows.length === 0) {
        return sendLoginResponse(res, 401, {
          error: "Invalid username or password",
        });
      }

      const user = rows[0];

      if (String(user.Status || "active") !== "active") {
        return sendLoginResponse(res, 403, { error: "Account suspended" });
      }

      const DBPassword = user.Password;
      const DBRole = user.Role;
      const DBalance = user.Balance;

      const PasswordCheck = await Bcrypt.compare(Password, DBPassword);
      if (!PasswordCheck) {
        return sendLoginResponse(res, 401, {
          error: "Invalid username or password",
        });
      }

      const GeneratedToken = Crypto.randomBytes(32).toString("hex");
      await DBConnection.query("DELETE FROM tokens WHERE Username = ?", [
        Username,
      ]);
      await DBConnection.query(
        "INSERT INTO tokens (Token, Username, Expires) VALUES (?, ?, NOW() + INTERVAL 12 HOUR)",
        [GeneratedToken, Username]
      );

      // `secure: false` because local dev runs over plain HTTP.
      res.cookie("token", GeneratedToken, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        maxAge: 12 * 60 * 60 * 1000, // 12 hours
      });

      const targetPage = ROLE_PAGES[String(DBRole)];
      if (!targetPage) {
        return sendLoginResponse(res, 403, {
          error: "Access Denied: unknown role",
        });
      }

      const response = {
        message: "Login Successful",
        username: Username,
        role: String(DBRole),
        redirectTo: targetPage,
        token: GeneratedToken,
      };

      if (DBalance !== null && DBalance !== undefined) {
        response.balance = DBalance;
      }

      return sendLoginResponse(res, 200, response);
    } catch (err) {
      console.error("Error during login:", err);
      return sendLoginResponse(res, 500, { error: "Login Failed" });
    }
  });

  return router;
};

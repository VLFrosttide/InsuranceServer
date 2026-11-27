"use strict";
const express = require("express");
const Bcrypt = require("bcryptjs");
const Crypto = require("crypto");
const { isBranchEnabled } = require("../db/branches.js");

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

  // The two platforms a session can belong to. The website and the desktop
  // client are usually open on the same PC, so each keeps its own session and
  // a login only replaces the session of the platform it comes from.
  const CLIENT_LABELS = new Set(["client", "desktop", "app", "electron"]);
  const WEB_LABELS = new Set(["web", "website", "site", "browser"]);

  /**
   * Which session bucket this login belongs to: "web" or "client".
   * Clients send `client: "web" | "client"`. When the field is missing (an
   * older build) an Electron User-Agent is treated as the desktop client so it
   * cannot evict the website's session; everything else is "web".
   *
   * @param {import("express").Request} req
   * @returns {"web" | "client"}
   */
  function resolveClientPlatform(req) {
    const raw =
      typeof req.body["client"] === "string"
        ? req.body["client"].trim().toLowerCase()
        : "";
    if (CLIENT_LABELS.has(raw)) return "client";
    if (WEB_LABELS.has(raw)) return "web";
    const userAgent = String(req.headers["user-agent"] || "");
    return /electron/i.test(userAgent) ? "client" : "web";
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

      // A soft-deleted account (an admin removed it from the Users panel) keeps
      // its row for record-keeping, but it can never sign in again. An admin can
      // restore it, which clears the flag.
      if (Number(user.Deleted) === 1) {
        return sendLoginResponse(res, 403, { error: "Account deleted" });
      }

      if (String(user.Status || "active") !== "active") {
        if (String(user.Status) === "pending") {
          return sendLoginResponse(res, 403, {
            error: "Account is pending admin approval",
          });
        }
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

      // A disabled branch must not be used to log in. The branch is optional on
      // the login payload (the worker client sends it when a branch is selected);
      // empty/unknown branches are allowed for backward compatibility.
      const loginBranch =
        typeof req.body["branch"] === "string" ? req.body["branch"].trim() : "";
      if (loginBranch && !(await isBranchEnabled(DBConnection, loginBranch))) {
        return sendLoginResponse(res, 403, { error: "Branch is disabled" });
      }

      const GeneratedToken = Crypto.randomBytes(32).toString("hex");
      const ClientPlatform = resolveClientPlatform(req);
      // Replace only THIS platform's session. The website ("web") and the
      // desktop client ("client") may be open on the same PC, and signing in on
      // one must never end the other's session, so the delete is scoped by
      // Device instead of by Username alone (deleting every token of the user
      // was what made the other client look "expired"). Expired rows of the
      // user are swept in the same statement; rows from before the Device
      // column existed stay "legacy" and just run out their 12 hours.
      await DBConnection.query(
        "DELETE FROM tokens WHERE Username = ? AND (Device = ? OR Expires <= NOW())",
        [Username, ClientPlatform]
      );
      await DBConnection.query(
        "INSERT INTO tokens (Token, Username, Device, Expires) VALUES (?, ?, ?, NOW() + INTERVAL 12 HOUR)",
        [GeneratedToken, Username, ClientPlatform]
      );

      // The token is delivered both as an HttpOnly cookie (for browser-style
      // clients) and in the JSON body below. The Electron client stores the
      // body token in localStorage and sends it back as `Authorization:
      // Bearer`, so it MUST be included in the JSON response. `Secure` ensures
      // the cookie is only sent over HTTPS. Local development over plain HTTP
      // can opt out via COOKIE_SECURE=false.
      const SECURE_COOKIE = process.env.COOKIE_SECURE !== "false";
      res.cookie("token", GeneratedToken, {
        httpOnly: true,
        secure: SECURE_COOKIE,
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
        token: GeneratedToken,
        username: Username,
        role: String(DBRole),
        // Which session bucket was used ("web" or "client"), so a client can
        // verify it landed in its own platform's session.
        client: ClientPlatform,
        redirectTo: targetPage,
      };

      if (DBalance !== null && DBalance !== undefined) {
        response.balance = DBalance;
      }

      // A broker-linked account gets its broker id so the client can decide
      // whether to allow a role-3 (client) login into the broker portal.
      if (user.BrokerId !== null && user.BrokerId !== undefined) {
        response.brokerId = user.BrokerId;
      }

      return sendLoginResponse(res, 200, response);
    } catch (err) {
      console.error("Error during login:", err);
      return sendLoginResponse(res, 500, { error: "Login Failed" });
    }
  });

  return router;
};

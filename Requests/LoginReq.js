"use strict";
import express from "express";
import Bcrypt from "bcrypt";
import Crypto from "crypto";

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
export function createLoginRouter(DBConnection) {
  const router = express.Router();

  router.post("/logme", async (req, res) => {
    try {
      const Username = req.body["username"];
      const Password = req.body["password"];

      if (!Username || !Password) {
        return res.status(400).json({
          error: "Username and Password are required",
        });
      }

      const [rows] = await DBConnection.query(
        "SELECT * FROM Users WHERE Username = ?",
        [Username]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const user = rows[0];
      const DBPassword = user.Password;
      const DBRole = user.Role;
      const DBalance = user.Balance;

      const PasswordCheck = await Bcrypt.compare(Password, DBPassword);
      if (!PasswordCheck) {
        return res.status(401).json({
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
      });

      const targetPage = ROLE_PAGES[String(DBRole)];
      if (!targetPage) {
        return res.status(403).json({
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

      console.log("Login Successful for user: ", Username, "->", targetPage);
      return res.status(200).json(response);
    } catch (err) {
      console.error("Error during login:", err);
      return res.status(500).json({ error: "Login Failed" });
    }
  });

  return router;
}

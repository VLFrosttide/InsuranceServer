"use strict";
const express = require("express");
const app = express();
const port = process.env.PORT || 8080;
const http = require("http");
// const path = require("path");
const httpServer = http.createServer(app);
const { Client } = require("pg");
const DBClient = new Client(process.env.ConString);
const Bcrypt = require("bcrypt");
const Crypto = require("crypto");
await DBClient.connect();

app.post("/logme", async (req, res) => {
  res.send("Got a POST request");
  try {
    let { Username, Password } = req.body;
    if (!Username || !Password) {
      return res.status(400).json({
        error: "Username and Password are required",
      });
    }

    const UsernameCheck = await DBClient.query(
      "SELECT * FROM Users WHERE Username = $1",
      [Username]
    );
    if (UsernameCheck.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid username or password",
      });
    }
    let User = result.rows[0];
    const PasswordCheck = await Bcrypt.compare(Password, User.Password);
    if (!PasswordCheck) {
      return res.status(401).json({
        error: "Invalid username or password",
      });
    } else {
      let GeneratedToken = Crypto.randomBytes(32).toString("hex");
      let StoredToken = await DBClient.query(
        "INSERT INTO Sessions (Token, Username, Expires) VALUES ($1, $2, NOW()+ INTERVAL '12 hours'",
        [GeneratedToken, Username]
      );
      res.cookie("Session", StoredToken, {
        httpOnly: true,
        secure: true,
      });
    }
  } catch (err) {
    res.status(500).json({ error: "Login Failed" });
  }
});
app.post("/userreg", async (req, res) => {
  try {
    const { Username, Password, RoleID } = req.body;
    if (!Username || !Password) {
      return res
        .status(400)
        .json({ error: "Username and password are required" });
    }
    let UserRoleID = await DBClient.query(
      "SELECT RoleID FROM Users WHERE Username = $1",
      [Username]
    );
    if (UserRoleID === "3") {
      const PassHash = await Bcrypt.hash(Password, 12);
      let NewUser = await DBClient.query(
        "INSERT INTO Users (Username, Password, RoleID) VALUES ($1, $2, $3)",
        [Username, PassHash, RoleID]
      );
      res.status(201).json({ message: "User Created" });
    } else {
      res.status(403).json({ error: "Access Denied" });
    }
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});
app.get("/", (req, res) => {
  res.send("Server is running");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});

// export { DBClient };

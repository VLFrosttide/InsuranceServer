import { DBConnection, app } from "../main.js";
import express from "express";
import Bcrypt from "bcrypt";
import Crypto from "crypto";
let LoginRouter = express.Router();



LoginRouter.post("/logme", async (req, res) => {
  try {
    // console.log(req.body);
    let Username = req.body["username"];
    let Password = req.body["password"];

    if (!Username || !Password) {
      return res.status(400).json({
        error: "Username and Password are required",
      });
    }

    const UsernameCheck = await DBConnection.query(
      "SELECT * FROM Users WHERE Username = ?",
      [Username]
    );
    console.log("Username Check:", UsernameCheck[0][0].Username);
    let DBUsername = UsernameCheck[0][0].Username;
    let DBPassword = UsernameCheck[0][0].Password;
    let DBRole = UsernameCheck[0][0].Role;
    if (DBUsername !== Username) {
      console.log("Username Check Failed:", DBUsername, Username);
      return res.status(401).json({
        error: "Invalid username",
      });
    }
    const PasswordCheck = await Bcrypt.compare(Password, DBPassword);
    console.log("Password Check:", PasswordCheck);
    if (!PasswordCheck) {
      console.log("Password Check Failed:");
      return res.status(401).json({
        error: "Invalid username or password",
      });
    } else {
      let GeneratedToken = Crypto.randomBytes(32).toString("hex");
      await DBConnection.query(    "DELETE FROM tokens WHERE Username = ?",[Username]   )
      let StoredToken = await DBConnection.query(
        "INSERT INTO tokens (Token, Username, Expires) VALUES (?, ?, NOW()+ INTERVAL 12 HOUR)",
        [GeneratedToken, Username]
      );
      res.cookie("token", StoredToken, {  
        httpOnly: true,
        secure: true,
      });
      res.status(200).json({
  message: "Login successful",
});


  console.log("Login Successful for user: ", Username);
    }
  } catch (err) {
    console.error("Error during login:", err);
    res.status(500).json({ error: "Login Failed" });
  }
});

export { LoginRouter };
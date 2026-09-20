import app from "../main.js";
import Bcrypt from "bcrypt";
import Crypto from "crypto";


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

"use strict";
// Idempotent database setup + seed for InsuranceServer.
// Creates the schema the server code expects and seeds demo accounts.
//
// Run from the repo root:
//   node --env-file=.env db/setup.js
//
// Requires .env to contain DBPassword (MySQL root password).
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";

const DB_NAME = "insurancedb";
const DB_PORT = 5500;

async function main() {
  const password = process.env.DBPassword;
  if (!password) {
    throw new Error("Missing DBPassword in .env");
  }

  // 1) Connect without a database and create it if missing.
  const server = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password,
    port: DB_PORT,
  });
  await server.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
  );
  await server.end();

  const db = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password,
    database: DB_NAME,
    port: DB_PORT,
  });

  // 2) Ensure Users.Role exists (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
  const [userCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "users"]
  );
  const userColNames = new Set(userCols.map((c) => c.COLUMN_NAME));
  if (!userColNames.has("Role")) {
    await db.query("ALTER TABLE users ADD COLUMN Role INT NOT NULL DEFAULT 3");
    console.log("Added users.Role column");
  }

  // 3) Ensure insurance.VehicleBrand exists (client collects vehicle brand).
  const [insCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "insurance"]
  );
  const insColNames = new Set(insCols.map((c) => c.COLUMN_NAME));
  if (!insColNames.has("VehicleBrand")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN VehicleBrand VARCHAR(45) NULL AFTER Otomobil"
    );
    console.log("Added insurance.VehicleBrand column");
  }

  // 4) Create tokens + tasks tables.
  await db.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      Token VARCHAR(64) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Expires DATETIME NOT NULL,
      PRIMARY KEY (Token),
      KEY idx_tokens_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INT NOT NULL AUTO_INCREMENT,
      Assignee VARCHAR(45) NOT NULL,
      Title VARCHAR(150) NOT NULL,
      Description TEXT NULL,
      Status VARCHAR(20) NOT NULL DEFAULT 'open',
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_tasks_assignee (Assignee)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // 5) Seed demo users (roles: 1=admin, 2=worker, 3=client).
  const users = [
    {
      username: "admin",
      password: "AdminPass123",
      role: 1,
      balance: 0,
      payout: null,
    },
    {
      username: "worker",
      password: "WorkerPass123",
      role: 2,
      balance: 0,
      payout: 50,
    },
    {
      username: "client",
      password: "ClientPass123",
      role: 3,
      balance: 250,
      payout: null,
    },
    // Matches the default credentials pre-filled in the Electron login page.
    {
      username: "list4e",
      password: "Pedese50",
      role: 2,
      balance: 0,
      payout: 40,
    },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 12);
    await db.query(
      `INSERT INTO users (Username, Password, Role, Balance, PayoutPercentage)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         Password = VALUES(Password),
         Role = VALUES(Role),
         Balance = VALUES(Balance),
         PayoutPercentage = VALUES(PayoutPercentage)`,
      [u.username, hash, u.role, u.balance, u.payout]
    );
  }
  console.log(
    "Seeded users:",
    users.map((u) => `${u.username} (role ${u.role})`).join(", ")
  );

  // 6) Seed a sample task + insurance so tier endpoints return data.
  const [taskCount] = await db.query("SELECT COUNT(*) AS n FROM tasks");
  if (taskCount[0].n === 0) {
    await db.query(
      `INSERT INTO tasks (Assignee, Title, Description, Status)
       VALUES (?, ?, ?, ?)`,
      [
        "list4e",
        "Review new policy",
        "Check the incoming insurance form.",
        "open",
      ]
    );
    console.log("Seeded a sample task for list4e");
  }

  const [insCount] = await db.query("SELECT COUNT(*) AS n FROM insurance");
  if (insCount[0].n === 0) {
    await db.query(
      `INSERT INTO insurance
        (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price, CurrencyType,
         Duration, BrokerCode, Branch, Otomobil, Cash, ClientName, ClientAdress,
         ChassisNumber, VehicleBrand, Broker)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "list4e",
        "34HRG539",
        "BG/02/FI26154498",
        "153056",
        "35",
        "EUR",
        15,
        "2.1",
        "ГКПП Лесово",
        "Otomobil",
        "true",
        "Ferhat Aktas",
        "Merkez/Edirne",
        "LSJA24U92PN242685",
        "Toyota",
        "client",
      ]
    );
    console.log("Seeded a sample insurance policy");
  }

  console.log("\nDatabase setup complete.");
  console.log("Demo logins:");
  for (const u of users) {
    console.log(`  ${u.username} / ${u.password}  (role ${u.role})`);
  }

  await db.end();
}

main().catch((err) => {
  console.error("Database setup failed:", err);
  process.exitCode = 1;
});

"use strict";
// Idempotent database setup + seed for InsuranceServer.
// Creates the schema the server code expects and seeds demo accounts.
//
// Run from the repo root:
//   node --env-file=.env db/setup.js
//
// Requires .env to contain DB_PASSWORD (MySQL root password).
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

const DB_NAME = process.env.DB_NAME || "insurancedb";
const DB_PORT = 5500;

async function main() {
  const password = process.env.DB_PASSWORD;
  if (!password) {
    throw new Error("Missing DB_PASSWORD in .env");
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

  // 1b) Create the core `users` and `insurance` tables when they are missing.
  // This makes the script work against a completely empty database. Existing
  // deployments keep their current tables (CREATE TABLE IF NOT EXISTS is a
  // no-op for them); the ALTER statements below handle legacy column shapes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      Username VARCHAR(45) NOT NULL,
      Password VARCHAR(200) NOT NULL,
      Role INT NOT NULL DEFAULT 3,
      Balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      PayoutPercentage DECIMAL(5,2) NULL,
      Status VARCHAR(20) NOT NULL DEFAULT 'active',
      PRIMARY KEY (Username),
      UNIQUE KEY Username_UNIQUE (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS insurance (
      Author VARCHAR(45) NOT NULL,
      CreationDate DATETIME NOT NULL,
      DKN VARCHAR(45) NOT NULL,
      PolicyNumber VARCHAR(45) NOT NULL,
      BlancNumber VARCHAR(45) NOT NULL,
      Price VARCHAR(45) NOT NULL,
      CurrencyType VARCHAR(45) NOT NULL,
      Duration INT NOT NULL,
      BrokerCode VARCHAR(45) NOT NULL,
      BrokerId INT NULL,
      Branch VARCHAR(45) NOT NULL,
      Otomobil VARCHAR(45) NOT NULL,
      VehicleBrand VARCHAR(45) NULL,
      PaymentType VARCHAR(45) NOT NULL,
      ClientName VARCHAR(45) NOT NULL,
      ClientAdress VARCHAR(45) NOT NULL,
      ChassisNumber VARCHAR(45) NOT NULL,
      Broker VARCHAR(45) NOT NULL,
      PRIMARY KEY (BlancNumber),
      UNIQUE KEY BlancNumber_UNIQUE (BlancNumber),
      KEY idx_insurance_broker (BrokerId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

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
  if (!userColNames.has("Status")) {
    await db.query(
      "ALTER TABLE users ADD COLUMN Status VARCHAR(20) NOT NULL DEFAULT 'active'"
    );
    console.log("Added users.Status column");
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

  // Link insurance policies to a broker (brokers.insurances relationship).
  if (!insColNames.has("BrokerId")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN BrokerId INT NULL AFTER BrokerCode, ADD KEY idx_insurance_broker (BrokerId)"
    );
    console.log("Added insurance.BrokerId column");
  }

  // Rename insurance.Cash -> insurance.PaymentType and store "Cash"/"Card"
  // instead of the legacy "true"/"false" (or "1"/"yes") flag values.
  if (insColNames.has("Cash") && !insColNames.has("PaymentType")) {
    await db.query("ALTER TABLE insurance RENAME COLUMN Cash TO PaymentType");
    console.log("Renamed insurance.Cash to PaymentType");
  }
  await db.query(
    "UPDATE insurance SET PaymentType = 'Cash' WHERE PaymentType IN ('true', '1', 'yes')"
  );
  await db.query(
    "UPDATE insurance SET PaymentType = 'Card' WHERE PaymentType NOT IN ('Cash', 'Card')"
  );

  // 4) Create the tokens table.
  await db.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      Token VARCHAR(64) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Expires DATETIME NOT NULL,
      PRIMARY KEY (Token),
      KEY idx_tokens_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // The legacy `tasks` table was only a demo work-item store; it is no longer
  // required by the server, so drop it on existing databases.
  await db.query("DROP TABLE IF EXISTS tasks");
  console.log("Dropped legacy tasks table");

  // CurrentCash support.
  //
  // Current cash is a single running balance. It is NOT reset automatically;
  // it resets only when an admin/worker calls POST /currentcash/reset.
  // `cash_transactions` is the ledger of increases/reductions (user + reason),
  // and `cash_resets` records who performed each reset and how much cash was
  // kept at that moment.
  //
  // Migration: the previous schema stored one row per calendar day (auto
  // reset). That per-day shape is obsolete; drop the legacy tables (they only
  // contain demo/test data) and recreate the single-balance shape.
  const [oldCashCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "current_cash"]
  );
  const oldCashColNames = new Set(oldCashCols.map((c) => c.COLUMN_NAME));
  if (oldCashColNames.has("CashDate")) {
    await db.query("DROP TABLE IF EXISTS cash_transactions");
    await db.query("DROP TABLE IF EXISTS current_cash");
    console.log("Migrated current_cash from per-day to single-balance schema");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS current_cash (
      id INT NOT NULL,
      CurrentCash DECIMAL(15,2) NOT NULL DEFAULT 0,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id INT NOT NULL AUTO_INCREMENT,
      Type VARCHAR(20) NOT NULL,
      Amount DECIMAL(15,2) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Reason VARCHAR(255) NOT NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cash_transactions_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_resets (
      id INT NOT NULL AUTO_INCREMENT,
      Username VARCHAR(45) NOT NULL,
      KeptAmount DECIMAL(15,2) NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cash_resets_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // CardBalance support.
  //
  // Card balance is a single running balance, separate from current cash. When
  // an insurance policy is created with PaymentType = "Card", its price is
  // added here instead of to current cash.
  //
  // Migration: the previous schema stored card payments in `card_payments`
  // (column `CardPayments`) and kept a `card_transactions` ledger. Rename the
  // balance table to `CardBalance`, migrate the column, and drop the ledger.
  await db.query("DROP TABLE IF EXISTS card_transactions");
  console.log("Dropped legacy card_transactions table");

  const [legacyCardTable] = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "card_payments"]
  );
  if (legacyCardTable.length > 0) {
    const [balanceTable] = await db.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [DB_NAME, "CardBalance"]
    );
    if (balanceTable.length === 0) {
      await db.query("RENAME TABLE card_payments TO CardBalance");
      console.log("Renamed card_payments to CardBalance");
    } else {
      await db.query("DROP TABLE IF EXISTS card_payments");
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS CardBalance (
      id INT NOT NULL,
      CardBalance DECIMAL(15,2) NOT NULL DEFAULT 0,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [cardBalanceCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "CardBalance"]
  );
  const cardBalanceColNames = new Set(
    cardBalanceCols.map((c) => c.COLUMN_NAME)
  );
  if (cardBalanceColNames.has("CardPayments")) {
    await db.query(
      "ALTER TABLE CardBalance RENAME COLUMN CardPayments TO CardBalance"
    );
    console.log("Renamed CardBalance.CardPayments to CardBalance");
  }

  // 4b) Create brokers + broker_emails tables.
  await db.query(`
    CREATE TABLE IF NOT EXISTS brokers (
      id INT NOT NULL AUTO_INCREMENT,
      Name VARCHAR(100) NOT NULL,
      CashBalance DECIMAL(15,2) NOT NULL DEFAULT 0,
      Percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
      PolicyRangeStart INT NOT NULL,
      PolicyRangeEnd INT NOT NULL,
      InactivePolicies INT NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_brokers_name (Name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS broker_emails (
      id INT NOT NULL AUTO_INCREMENT,
      BrokerId INT NOT NULL,
      Email VARCHAR(255) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_broker_email (BrokerId, Email),
      KEY idx_broker_emails_broker (BrokerId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Migrate brokers to the current schema on existing databases.
  // - Rename TotalGivenPolicies -> InactivePolicies.
  // - Add the Percentage column (commission charged per policy).
  // - Widen CashBalance to a decimal so fractional charges are preserved.
  const [brokerCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "brokers"]
  );
  const brokerColNames = new Set(brokerCols.map((c) => c.COLUMN_NAME));
  if (
    brokerColNames.has("TotalGivenPolicies") &&
    !brokerColNames.has("InactivePolicies")
  ) {
    await db.query(
      "ALTER TABLE brokers RENAME COLUMN TotalGivenPolicies TO InactivePolicies"
    );
    console.log("Renamed brokers.TotalGivenPolicies to InactivePolicies");
  }
  if (!brokerColNames.has("Percentage")) {
    await db.query(
      "ALTER TABLE brokers ADD COLUMN Percentage DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER PolicyRangeEnd"
    );
    console.log("Added brokers.Percentage column");
  }
  await db.query(
    "ALTER TABLE brokers MODIFY COLUMN CashBalance DECIMAL(15,2) NOT NULL DEFAULT 0"
  );

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

  // 6) Seed a sample insurance so tier endpoints return data.
  const [insCount] = await db.query("SELECT COUNT(*) AS n FROM insurance");
  if (insCount[0].n === 0) {
    await db.query(
      `INSERT INTO insurance
        (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price, CurrencyType,
         Duration, BrokerCode, Branch, Otomobil, PaymentType, ClientName, ClientAdress,
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
        "Cash",
        "Ferhat Aktas",
        "Merkez/Edirne",
        "LSJA24U92PN242685",
        "Toyota",
        "client",
      ]
    );
    console.log("Seeded a sample insurance policy");
  }

  // 7) Seed a demo broker (multiple emails, cash balance, policy range,
  //    total given policies) and link insurances to it.
  await db.query(
    `INSERT INTO brokers (Name, CashBalance, Percentage, PolicyRangeStart, PolicyRangeEnd, InactivePolicies)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       CashBalance = VALUES(CashBalance),
       Percentage = VALUES(Percentage),
       PolicyRangeStart = VALUES(PolicyRangeStart),
       PolicyRangeEnd = VALUES(PolicyRangeEnd),
       InactivePolicies = VALUES(InactivePolicies)`,
    ["Demo Broker", 1000, 10, 100, 500, 400]
  );

  const [[brokerRow]] = await db.query(
    "SELECT id FROM brokers WHERE Name = ?",
    ["Demo Broker"]
  );
  const brokerId = brokerRow.id;

  // A broker can have multiple emails.
  for (const email of [
    "demo@broker.example",
    "sales@broker.example",
    "support@broker.example",
  ]) {
    await db.query(
      `INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE Email = VALUES(Email)`,
      [brokerId, email]
    );
  }

  // Seed a dedicated insurance policy (own test values) linked to the broker
  // via insurance.BrokerId, so the broker always has linked insurance.
  await db.query(
    `INSERT INTO insurance
       (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price, CurrencyType,
        Duration, BrokerCode, Branch, Otomobil, PaymentType, ClientName, ClientAdress,
        ChassisNumber, VehicleBrand, Broker, BrokerId)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE BrokerId = VALUES(BrokerId)`,
    [
      "list4e",
      "34TEST539",
      "BG/02/TEST5498",
      "TEST-BROKER-001",
      "99",
      "EUR",
      30,
      "2.1",
      "ГКПП Лесово",
      "Otomobil",
      "Cash",
      "Sample Broker Client",
      "Sample Address",
      "SAMPLE-CHASSIS-001",
      "Toyota",
      "client",
      brokerId,
    ]
  );

  // Also attach any existing unlinked insurance rows to the demo broker.
  await db.query("UPDATE insurance SET BrokerId = ? WHERE BrokerId IS NULL", [
    brokerId,
  ]);

  // 8) Console log a sample broker with its multiple emails and linked
  //    insurance policies from the insurance table.
  const [brokers] = await db.query(
    `SELECT id, Name, CashBalance, Percentage, PolicyRangeStart, PolicyRangeEnd, InactivePolicies
     FROM brokers WHERE id = ?`,
    [brokerId]
  );
  const [emailRows] = await db.query(
    "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
    [brokerId]
  );
  const [insuranceRows] = await db.query(
    `SELECT PolicyNumber, BlancNumber, ClientName, Price, CurrencyType, BrokerId
     FROM insurance WHERE BrokerId = ?`,
    [brokerId]
  );

  const sampleBroker = {
    ...brokers[0],
    emails: emailRows.map((r) => r.Email),
    insurances: insuranceRows,
  };
  console.log("Sample broker:");
  console.log(JSON.stringify(sampleBroker, null, 2));

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

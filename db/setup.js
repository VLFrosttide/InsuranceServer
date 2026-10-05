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

/**
 * Run the idempotent schema creation + test-data seed.
 *
 * @param {{host?: string, port?: number|string, user?: string,
 *          password?: string, database?: string}} [config]
 *   Optional connection overrides. Falls back to env vars / sensible local
 *   defaults so the script still runs standalone (`npm run db:setup`).
 */
async function runSetup(config = {}) {
  const DB_NAME = config.database || process.env.DB_NAME || "insurancedb";
  const host = config.host || process.env.DB_HOST || "localhost";
  const user = config.user || process.env.DB_USER || "root";
  const port = Number(config.port || process.env.DB_PORT || 5500);
  const password = config.password || process.env.DB_PASSWORD;
  if (!password) {
    throw new Error("Missing DB_PASSWORD in .env");
  }

  // 1) Try the target database directly first. On shared/released hosting the
  // database is usually pre-provisioned and the DB user often lacks the
  // server-level CREATE privilege, so only issue CREATE DATABASE when the
  // database does not exist yet (error 1049 = ER_BAD_DB_ERROR).
  let db;
  try {
    db = await mysql.createConnection({
      host,
      user,
      password,
      database: DB_NAME,
      port,
    });
  } catch (err) {
    if (!err || err.code !== "ER_BAD_DB_ERROR") {
      throw err;
    }

    const server = await mysql.createConnection({
      host,
      user,
      password,
      port,
    });
    await server.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
    await server.end();

    db = await mysql.createConnection({
      host,
      user,
      password,
      database: DB_NAME,
      port,
    });
  }

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
      PolicyNumber VARCHAR(45) NOT NULL,
      BlancNumber VARCHAR(45) NOT NULL,
      CarNumber VARCHAR(45) NOT NULL DEFAULT '',
      Price VARCHAR(45) NOT NULL,
      CurrencyType VARCHAR(45) NOT NULL,
      Duration INT NOT NULL,
      Broker VARCHAR(100) NULL,
      BrokerId INT NULL,
      Branch VARCHAR(45) NOT NULL,
      Otomobil VARCHAR(45) NOT NULL,
      StartDate DATE NULL,
      PaymentType VARCHAR(45) NOT NULL,
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

  // 3) Migrate the insurance table to the reduced schema.
  //
  // The add-insurance form now only collects: PolicyNumber, BlancNumber,
  // Duration, Otomobil, StartDate, Price, CurrencyType, PaymentType. Author and
  // CreationDate are filled by the server, Branch is selected at login, and
  // Broker is inferred from the incoming email sender. Drop every legacy column
  // that no longer exists on the form.
  const [insCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "insurance"]
  );
  const insColNames = new Set(insCols.map((c) => c.COLUMN_NAME));

  const legacyInsuranceColumns = [
    "DKN",
    "BrokerCode",
    "ClientName",
    "ClientAdress",
    "ChassisNumber",
    "VehicleBrand",
    "ExpirationDate",
  ];
  for (const col of legacyInsuranceColumns) {
    if (insColNames.has(col)) {
      await db.query(`ALTER TABLE insurance DROP COLUMN \`${col}\``);
      console.log(`Dropped insurance.${col} column`);
    }
  }

  // Broker is now inferred from the email sender and may be unknown until then,
  // so it must permit NULL (and be wide enough to hold a broker name).
  await db
    .query("ALTER TABLE insurance MODIFY COLUMN Broker VARCHAR(100) NULL")
    .catch(() => {});

  // Link insurance policies to a broker (brokers.insurances relationship).
  if (!insColNames.has("BrokerId")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN BrokerId INT NULL AFTER Broker, ADD KEY idx_insurance_broker (BrokerId)"
    );
    console.log("Added insurance.BrokerId column");
  }

  // The add-insurance form now submits StartDate, but `CREATE TABLE IF NOT
  // EXISTS` above only guarantees it on a brand-new table. Add it to existing
  // databases that were created before this column was introduced, otherwise
  // the sample/broker policy seeds below fail with "Unknown column 'StartDate'".
  if (!insColNames.has("StartDate")) {
    await db.query("ALTER TABLE insurance ADD COLUMN StartDate DATE NULL");
    console.log("Added insurance.StartDate column");
  }

  // Car number / Номер автомобил: required on the add-insurance form.
  if (!insColNames.has("CarNumber")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN CarNumber VARCHAR(45) NOT NULL DEFAULT ''"
    );
    console.log("Added insurance.CarNumber column");
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

  // Annulment support: a worker/admin can annul a policy, refunding its price
  // (minus a fee that depends on the fault reason) and reversing its effect
  // on the broker balance (if any). Add the columns to existing databases.
  if (!insColNames.has("Annulled")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN Annulled TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added insurance.Annulled column");
  }
  if (!insColNames.has("AnnulReason")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN AnnulReason VARCHAR(20) NULL"
    );
    console.log("Added insurance.AnnulReason column");
  }
  if (!insColNames.has("AnnulFee")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN AnnulFee DECIMAL(15,2) NULL"
    );
    console.log("Added insurance.AnnulFee column");
  }
  if (!insColNames.has("AnnulDate")) {
    await db.query("ALTER TABLE insurance ADD COLUMN AnnulDate DATETIME NULL");
    console.log("Added insurance.AnnulDate column");
  }
  if (!insColNames.has("AnnulBy")) {
    await db.query("ALTER TABLE insurance ADD COLUMN AnnulBy VARCHAR(45) NULL");
    console.log("Added insurance.AnnulBy column");
  }

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

  // Migration: the old single-currency tables never stored a Currency, so we
  // rebuild them when the column is missing. The previous table shape (plain
  // `current_cash(id, CurrentCash)`) holds only a demo balance and is safe to
  // drop and recreate with the per-currency composite key.
  const [cashTxCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "cash_transactions"]
  );
  const cashTxColNames = new Set(cashTxCols.map((c) => c.COLUMN_NAME));
  if (!cashTxColNames.has("Currency")) {
    await db.query("DROP TABLE IF EXISTS cash_transactions");
    await db.query("DROP TABLE IF EXISTS cash_resets");
    await db.query("DROP TABLE IF EXISTS current_cash");
    console.log("Migrated current cash to multi-currency schema");
  }

  // Migration: current cash is now per-branch. Drop and recreate tables when
  // the Branch column is missing so existing deployments get a clean schema.
  const [cashBranchCheck] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "current_cash"]
  );
  const cashBranchColNames = new Set(cashBranchCheck.map((c) => c.COLUMN_NAME));
  if (!cashBranchColNames.has("Branch")) {
    await db.query("DROP TABLE IF EXISTS cash_transactions");
    await db.query("DROP TABLE IF EXISTS cash_resets");
    await db.query("DROP TABLE IF EXISTS current_cash");
    console.log("Migrated current cash to per-branch schema");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS current_cash (
      id INT NOT NULL,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      CurrentCash DECIMAL(15,2) NOT NULL DEFAULT 0,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id, Branch, Currency),
      KEY idx_current_cash_branch (Branch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id INT NOT NULL AUTO_INCREMENT,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Type VARCHAR(20) NOT NULL,
      Amount DECIMAL(15,2) NOT NULL,
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      Username VARCHAR(45) NOT NULL,
      Reason VARCHAR(255) NOT NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cash_transactions_branch (Branch),
      KEY idx_cash_transactions_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_resets (
      id INT NOT NULL AUTO_INCREMENT,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Username VARCHAR(45) NOT NULL,
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      KeptAmount DECIMAL(15,2) NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cash_resets_branch (Branch),
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

  // Insert demo accounts only when they are missing. Because this now runs on
  // every server start, we must NOT overwrite existing rows (an operator may
  // have changed a password or balance; a restart must not reset that).
  for (const u of users) {
    const [existing] = await db.query(
      "SELECT Username FROM users WHERE Username = ?",
      [u.username]
    );
    if (existing.length > 0) {
      continue;
    }
    const hash = await bcrypt.hash(u.password, 12);
    await db.query(
      `INSERT INTO users (Username, Password, Role, Balance, PayoutPercentage)
       VALUES (?, ?, ?, ?, ?)`,
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
        (Author, CreationDate, PolicyNumber, BlancNumber, Price, CurrencyType,
         Duration, Broker, Branch, Otomobil, PaymentType, StartDate)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "list4e",
        "BG/02/FI26154498",
        "153056",
        "35",
        "EUR",
        15,
        "Demo Broker",
        "ГКПП Лесово",
        "Otomobil",
        "Cash",
        null,
      ]
    );
    console.log("Seeded a sample insurance policy");
  }

  // 7) Seed a demo broker (multiple emails, cash balance, policy range,
  //    total given policies) and link insurances to it.
  // Insert the demo broker only when missing so a restart does not reset its
  // balance/percentage back to the seed values.
  const [brokerExisting] = await db.query(
    "SELECT id FROM brokers WHERE Name = ?",
    ["Demo Broker"]
  );
  if (brokerExisting.length === 0) {
    await db.query(
      `INSERT INTO brokers (Name, CashBalance, Percentage, PolicyRangeStart, PolicyRangeEnd, InactivePolicies)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["Demo Broker", 1000, 10, 100, 500, 400]
    );
  }

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
       (Author, CreationDate, PolicyNumber, BlancNumber, Price, CurrencyType,
        Duration, Broker, Branch, Otomobil, PaymentType, StartDate, BrokerId)
     VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE BrokerId = VALUES(BrokerId)`,
    [
      "list4e",
      "BG/02/TEST5498",
      "TEST-BROKER-001",
      "99",
      "EUR",
      30,
      "Demo Broker",
      "ГКПП Лесово",
      "Otomobil",
      "Cash",
      null,
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
    `SELECT PolicyNumber, BlancNumber, Broker, Price, CurrencyType, BrokerId
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

module.exports = { runSetup };

// Allow `npm run db:setup` to run this file directly.
if (require.main === module) {
  runSetup().catch((err) => {
    console.error("Database setup failed:", err);
    process.exitCode = 1;
  });
}

"use strict";
// Idempotent database setup for InsuranceServer.
// Creates/upgrades the schema the server code expects.
//
// Run from the repo root:
//   node --env-file=.env db/setup.js
//
// Requires .env to contain DB_PASSWORD (MySQL root password).

const mysql = require("mysql2/promise");
const { separateBrokerCash } = require("./separateBrokerCash.js");
const {
  ensureBrokerPaymentsTable,
  backfillBrokerPayments,
} = require("./brokerPayments.js");

/**
 * One-time split of the old global card balance into per-branch balances
 * (same statements as migrations/009_branch_card_balance.sql). Runs only
 * while `branch_card_balance` is empty, so it never overwrites live data.
 *
 * Each branch starts with its card share from total_cash.CardPart (summed over
 * currencies) - the card money its policies brought in since the last clear.
 * Whatever part of the old global CardBalance is not linked to any branch is
 * kept on an unassigned ('') row, so no card money silently disappears.
 *
 * @param {import("mysql2/promise").Connection} db
 */
async function seedBranchCardBalances(db) {
  const [[existing]] = await db.query(
    "SELECT COUNT(*) AS n FROM branch_card_balance"
  );
  if (Number(existing.n) > 0) return;

  await db.query(`
    INSERT INTO branch_card_balance (Branch, CardBalance)
    SELECT Branch, ROUND(SUM(CardPart), 2)
      FROM total_cash
     GROUP BY Branch
    HAVING SUM(CardPart) <> 0
  `);

  const [legacy] = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CardBalance'"
  );
  if (Number(legacy[0].n) > 0) {
    await db.query(`
      INSERT INTO branch_card_balance (Branch, CardBalance)
      SELECT '', ROUND(cb.CardBalance - COALESCE(s.total, 0), 2)
        FROM CardBalance cb
        LEFT JOIN (SELECT SUM(CardBalance) AS total FROM branch_card_balance) s ON 1 = 1
       WHERE cb.id = 1
         AND ROUND(cb.CardBalance - COALESCE(s.total, 0), 2) <> 0
      ON DUPLICATE KEY UPDATE CardBalance = CardBalance + VALUES(CardBalance)
    `);
  }
  console.log("Split the card balance into per-branch balances");
}

/**
 * Run the idempotent schema creation/upgrades.
 *
 * Schema changes (CREATE/ALTER) always run, so a brand-new or upgraded
 * database matches what the server code expects. Every step that writes or
 * rewrites DATA (seeding the branch registry, backfills, balance
 * recalculations) runs only when `seed` is true.
 *
 * `npm run db:setup` and db/seed-from-live.ps1 seed by default. The server
 * passes `seed: false`, so restarting it never re-seeds the database or
 * recalculates balances behind the operator's back; set DB_SEED_ON_START=1 to
 * opt back in.
 *
 * @param {{host?: string, port?: number|string, user?: string,
 *          password?: string, database?: string, seed?: boolean}} [config]
 *   Optional connection overrides. Falls back to env vars / sensible local
 *   defaults so the script still runs standalone (`npm run db:setup`).
 */
async function runSetup(config = {}) {
  // A missing `seed` means "run the whole setup": that is what the CLI and
  // db/seed-from-live.ps1 expect. Only an explicit `seed: false` skips the
  // data steps.
  const seed = config.seed !== false;
  const DB_NAME = config.database || process.env.DB_NAME || "insurancedb";
  const host = config.host || process.env.DB_HOST || "localhost";
  const user = config.user || process.env.DB_USER || "root";
  const port = Number(config.port || process.env.DB_PORT || 5500);
  const password = config.password || process.env.DB_PASSWORD;
  if (!password) {
    throw new Error("Missing DB_PASSWORD in .env");
  }
  if (!seed) {
    console.log(
      "Schema only: data seeding/backfills are skipped " +
        "(run `npm run db:setup` or set DB_SEED_ON_START=1 when you want them)."
    );
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
      Status VARCHAR(20) NOT NULL DEFAULT 'active',
      Email VARCHAR(255) NULL,
      Deleted TINYINT(1) NOT NULL DEFAULT 0,
      DeletedAt DATETIME NULL,
      DeletedBy VARCHAR(45) NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      OriginalPrice VARCHAR(45) NULL,
      CurrencyType VARCHAR(45) NOT NULL,
      Duration INT NOT NULL,
      Broker VARCHAR(100) NULL,
      BrokerId INT NULL,
      Branch VARCHAR(45) NOT NULL,
      Otomobil VARCHAR(45) NOT NULL,
      Kind VARCHAR(20) NOT NULL DEFAULT 'border',
      StartDate DATE NULL,
      PaymentType VARCHAR(45) NOT NULL,
      NonTurk TINYINT(1) NOT NULL DEFAULT 0,
      CardFee TINYINT(1) NOT NULL DEFAULT 0,
      Annulled TINYINT(1) NOT NULL DEFAULT 0,
      AnnulReason VARCHAR(20) NULL,
      AnnulFee DECIMAL(15,2) NULL,
      AnnulDate DATETIME NULL,
      AnnulBy VARCHAR(45) NULL,
      Deleted TINYINT(1) NOT NULL DEFAULT 0,
      DeletedAt DATETIME NULL,
      DeletedBy VARCHAR(45) NULL,
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
  // Links a client (role 3) account to a broker so the broker can log in and
  // access only their own broker data on the website.
  if (!userColNames.has("BrokerId")) {
    await db.query("ALTER TABLE users ADD COLUMN BrokerId INT NULL");
    console.log("Added users.BrokerId column");
  }
  // Contact email captured at self-service registration (shown to admins while
  // reviewing pending accounts) and the account creation time.
  if (!userColNames.has("Email")) {
    await db.query("ALTER TABLE users ADD COLUMN Email VARCHAR(255) NULL");
    console.log("Added users.Email column");
  }
  if (!userColNames.has("CreatedAt")) {
    await db.query(
      "ALTER TABLE users ADD COLUMN CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
    );
    console.log("Added users.CreatedAt column");
  }
  // Soft-delete support for accounts: an admin can delete a user from the Users
  // panel. The row is never physically removed — it is only tagged as Deleted so
  // the account (and everything it authored) stays in the database and an admin
  // can restore it. A deleted account cannot sign in and is hidden from the
  // users list.
  if (!userColNames.has("Deleted")) {
    await db.query(
      "ALTER TABLE users ADD COLUMN Deleted TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added users.Deleted column");
  }
  if (!userColNames.has("DeletedAt")) {
    await db.query("ALTER TABLE users ADD COLUMN DeletedAt DATETIME NULL");
    console.log("Added users.DeletedAt column");
  }
  if (!userColNames.has("DeletedBy")) {
    await db.query("ALTER TABLE users ADD COLUMN DeletedBy VARCHAR(45) NULL");
    console.log("Added users.DeletedBy column");
  }
  // Prune the legacy payout percentage column. No percentages are used.
  if (userColNames.has("PayoutPercentage")) {
    await db.query("ALTER TABLE users DROP COLUMN PayoutPercentage");
    console.log("Dropped users.PayoutPercentage column");
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
    "UPDATE insurance SET PaymentType = 'Card' WHERE PaymentType NOT IN ('Cash', 'Card', 'Broker')"
  );

  // Email policies are paid ONLY from the broker's balance and carry the
  // "Broker" payment type. Before that type existed they were stored as "Cash"
  // (while already being funded by the broker balance), so relabel them. This
  // moves no money: those rows were never in current cash. Legacy email rows
  // stored as "Card" are left alone - their price really is in CardBalance.
  await db.query(
    "UPDATE insurance SET PaymentType = 'Broker' WHERE BrokerId IS NOT NULL AND PaymentType = 'Cash'"
  );

  // Walk-in policies (no BrokerId - not created from a broker's email) record
  // the branch that issued them as their broker. Older walk-ins were stored
  // with an empty Broker, so fill it in from their Branch. BrokerId stays NULL,
  // so this moves no money and does not make them broker-paid.
  const [walkInBackfill] = await db.query(
    `UPDATE insurance
        SET Broker = Branch
      WHERE BrokerId IS NULL
        AND (Broker IS NULL OR Broker = '')
        AND Branch IS NOT NULL
        AND Branch <> ''`
  );
  if (walkInBackfill && walkInBackfill.affectedRows) {
    console.log(
      `Recorded the branch as the broker of ${walkInBackfill.affectedRows} walk-in insurance(s)`
    );
  }

  // Optional surcharges chosen on the add-insurance form. Their amounts
  // (+5 for NonTurk, +2 for CardFee) are already included in Price; these
  // flags record which ones were applied.
  if (!insColNames.has("NonTurk")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN NonTurk TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added insurance.NonTurk column");
  }
  if (!insColNames.has("CardFee")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN CardFee TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added insurance.CardFee column");
  }

  // Which product the policy is (Requests/InsuranceKinds.js):
  //   border  - Border insurance, the main one; any employee may create it.
  //   medical - Medical insurance, admins only.
  //   civil   - Civil liability, admins only.
  // The column default is "border", so every policy written before this column
  // existed is a border insurance - nothing has to be backfilled or guessed.
  if (!insColNames.has("Kind")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN Kind VARCHAR(20) NOT NULL DEFAULT 'border' AFTER Otomobil"
    );
    console.log("Added insurance.Kind column");
  }

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
  // The annulment tax becomes the policy's new price: Price holds the fee while
  // Annulled = 1 and OriginalPrice keeps the price the policy was sold at, so
  // refunds, un-annulling, deletes/restores and broker bills still work with
  // the original amount. Existing annulled rows are converted once (the
  // OriginalPrice guard keeps a restart from converting them twice).
  if (!insColNames.has("OriginalPrice")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN OriginalPrice VARCHAR(45) NULL"
    );
    console.log("Added insurance.OriginalPrice column");
  }
  const [converted] = await db.query(
    `UPDATE insurance
        SET OriginalPrice = Price,
            Price = CAST(COALESCE(AnnulFee, 0) AS CHAR)
      WHERE Annulled = 1 AND OriginalPrice IS NULL`
  );
  if (converted && converted.affectedRows > 0) {
    console.log(
      `Set the annulment fee as the price of ${converted.affectedRows} annulled insurance(s)`
    );
  }

  // Soft-delete support: an admin can delete a policy from the admin panel.
  // The row is never physically removed — it is only tagged as Deleted so it
  // keeps being kept in the database for record-keeping, but is excluded from
  // every list/search endpoint and from reconciliation/report parsing.
  if (!insColNames.has("Deleted")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN Deleted TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added insurance.Deleted column");
  }
  if (!insColNames.has("DeletedAt")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN DeletedAt DATETIME NULL"
    );
    console.log("Added insurance.DeletedAt column");
  }
  if (!insColNames.has("DeletedBy")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN DeletedBy VARCHAR(45) NULL"
    );
    console.log("Added insurance.DeletedBy column");
  }

  // Structural link between a policy and the history row of its SALE. The
  // history page pairs a row with a policy by BlancNumber, so a blanc
  // correction that did not carry the row along used to leave the charge
  // attached to nothing (the page then hid it). With this link the sale row
  // follows the policy through any number of blanc corrections; the unique key
  // makes one movement belong to at most one policy. Rows written before the
  // link existed are matched once by backfillInsuranceSaleLinks below.
  if (!insColNames.has("SaleMovementId")) {
    await db.query(
      "ALTER TABLE insurance ADD COLUMN SaleMovementId INT NULL AFTER DeletedBy, " +
        "ADD UNIQUE KEY unique_insurance_sale_movement (SaleMovementId)"
    );
    console.log("Added insurance.SaleMovementId column");
  }

  // 4) Create the tokens table.
  //
  // A session belongs to exactly one platform: 'web' (the website, sent as an
  // HttpOnly cookie or a Bearer token) or 'client' (the desktop client, Bearer
  // from localStorage). Both are usually open on the same PC, so each keeps its
  // own session and a login only replaces the session of its own platform.
  await db.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      Token VARCHAR(64) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Device VARCHAR(16) NOT NULL DEFAULT 'web',
      Expires DATETIME NOT NULL,
      PRIMARY KEY (Token),
      KEY idx_tokens_user_device (Username, Device)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Existing installs: add tokens.Device. Sessions issued before the column
  // existed are marked 'legacy' rather than 'web', so the first login after the
  // upgrade cannot delete a session that belongs to the other platform; they
  // simply expire (12 hours) and are swept below.
  const [tokenCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "tokens"]
  );
  const tokenColNames = new Set(tokenCols.map((c) => c.COLUMN_NAME));
  if (!tokenColNames.has("Device")) {
    await db.query(
      "ALTER TABLE tokens ADD COLUMN Device VARCHAR(16) NOT NULL DEFAULT 'legacy' AFTER Username, " +
        "ADD KEY idx_tokens_user_device (Username, Device)"
    );
    // New rows always carry a Device from /logme; the default is only a
    // fallback for anything else that inserts a token.
    await db.query("ALTER TABLE tokens ALTER COLUMN Device SET DEFAULT 'web'");
    console.log("Added tokens.Device column");
  }

  // Sessions expire after 12 hours. Sweep the dead ones on start; /logme also
  // prunes the logging-in user's expired rows.
  await db.query("DELETE FROM tokens WHERE Expires <= NOW()");

  // Gmail token refresh reminder: records which Saturday the reminder was last
  // sent so a server restart on the same Saturday does not send it again.
  await db.query(`
    CREATE TABLE IF NOT EXISTS gmail_token_reminder (
      id INT NOT NULL,
      LastRemindedSaturday VARCHAR(10) NULL,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await db.query("INSERT IGNORE INTO gmail_token_reminder (id) VALUES (1)");

  // Durable retry queue for reply emails that fail to send through the Gmail
  // API. Failed replies are stored here and retried in the background with
  // exponential backoff (see Mail/emailOutbox.js), surviving server restarts.
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id INT NOT NULL AUTO_INCREMENT,
      MessageId VARCHAR(255) NOT NULL,
      Account VARCHAR(45) NOT NULL DEFAULT '',
      Recipient VARCHAR(255) NOT NULL DEFAULT '',
      Subject VARCHAR(500) NOT NULL DEFAULT '',
      Attachments LONGTEXT NULL,
      BodyText MEDIUMTEXT NULL,
      Status ENUM('pending','failed','sent') NOT NULL DEFAULT 'pending',
      Attempts INT NOT NULL DEFAULT 0,
      NextAttemptAt DATETIME NOT NULL,
      LastError VARCHAR(500) NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_email_outbox_due (Status, NextAttemptAt)
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

  // `cash_transactions` is the drawer's ledger. A row is never physically
  // removed: an admin deleting a ledger entry from the Current cash screen
  // flags it with Deleted/DeletedAt/DeletedBy (soft delete), so the record of
  // what happened survives while the row stops counting anywhere.
  //
  // `Type` is 'increase', 'reduce' (an expense) or 'handover' (money physically
  // given to a person - see the file header of Requests/CurrentCash.js).
  // `Recipient` names the person who took hand-over money and stays NULL for
  // every other movement.
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id INT NOT NULL AUTO_INCREMENT,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Type VARCHAR(20) NOT NULL,
      Amount DECIMAL(15,2) NOT NULL,
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      Username VARCHAR(45) NOT NULL,
      Reason VARCHAR(255) NOT NULL,
      Recipient VARCHAR(100) NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Deleted TINYINT(1) NOT NULL DEFAULT 0,
      DeletedAt DATETIME NULL,
      DeletedBy VARCHAR(45) NULL,
      PRIMARY KEY (id),
      KEY idx_cash_transactions_branch (Branch),
      KEY idx_cash_transactions_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Columns added to ledgers created before they existed (MySQL 8 has no
  // ADD COLUMN IF NOT EXISTS). Same shape as the broker_balance_movements
  // migration further down.
  const [cashTxColsNow] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "cash_transactions"]
  );
  const cashTxColumnNames = new Set(cashTxColsNow.map((c) => c.COLUMN_NAME));
  if (!cashTxColumnNames.has("Deleted")) {
    await db.query(
      "ALTER TABLE cash_transactions ADD COLUMN Deleted TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added cash_transactions.Deleted column");
  }
  if (!cashTxColumnNames.has("DeletedAt")) {
    await db.query(
      "ALTER TABLE cash_transactions ADD COLUMN DeletedAt DATETIME NULL"
    );
    console.log("Added cash_transactions.DeletedAt column");
  }
  if (!cashTxColumnNames.has("DeletedBy")) {
    await db.query(
      "ALTER TABLE cash_transactions ADD COLUMN DeletedBy VARCHAR(45) NULL"
    );
    console.log("Added cash_transactions.DeletedBy column");
  }
  if (!cashTxColumnNames.has("Recipient")) {
    await db.query(
      "ALTER TABLE cash_transactions ADD COLUMN Recipient VARCHAR(100) NULL AFTER Reason"
    );
    console.log("Added cash_transactions.Recipient column");
  }

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

  // Returns of money that was handed over to a person ("Undo hand over" on the
  // Current cash screen). A hand-over can be returned in parts, either to the
  // branch drawer - which increases available cash through a matching
  // `cash_transactions` row of Type 'handover_return' - or straight to the
  // company bank account, which touches no drawer and only lowers how much is
  // still handed over. The original hand-over stays in its ledger, so the whole
  // history is kept; this table links a return to it and to the ledger row that
  // put the money back (when the destination was the drawer).
  //
  // `HandoverType` is 'cash' today ('broker' is reserved for broker-balance
  // hand-overs; those carry no branch and are undone from the broker history).
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_handover_returns (
      id INT NOT NULL AUTO_INCREMENT,
      HandoverType VARCHAR(20) NOT NULL,
      CashTransactionId INT NULL,
      BrokerMovementId INT NULL,
      CashReturnTransactionId INT NULL,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      BrokerId INT NULL,
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      Amount DECIMAL(15,2) NOT NULL,
      Destination VARCHAR(20) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Reason VARCHAR(255) NOT NULL DEFAULT '',
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_handover_returns_cash (CashTransactionId),
      KEY idx_handover_returns_broker (BrokerMovementId),
      KEY idx_handover_returns_branch_time (Branch, CreatedAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    COMMENT='Returns/undos of handed-over money (office drawer or company bank)'
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

  // `card_resets` records who cleared the card balance and how much was kept
  // (i.e. the balance just before it was zeroed), mirroring `cash_resets`.
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_resets (
      id INT NOT NULL AUTO_INCREMENT,
      Username VARCHAR(45) NOT NULL,
      KeptAmount DECIMAL(15,2) NOT NULL DEFAULT 0,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_card_resets_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Card resets are per branch now: record which branch was cleared.
  const [cardResetCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "card_resets"]
  );
  if (!cardResetCols.some((c) => c.COLUMN_NAME === "Branch")) {
    await db.query(
      "ALTER TABLE card_resets ADD COLUMN Branch VARCHAR(45) NOT NULL DEFAULT '' AFTER id"
    );
    console.log("Added card_resets.Branch");
  }

  // Card balance per branch. Replaces the single global CardBalance row, so
  // each branch's "Reset to 0" clears only that branch's card money.
  await db.query(`
    CREATE TABLE IF NOT EXISTS branch_card_balance (
      Branch VARCHAR(45) NOT NULL,
      CardBalance DECIMAL(15,2) NOT NULL DEFAULT 0,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (Branch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  // (Filled from total_cash further below, once that table exists.)

  // 4a2) Total cash - the second record of cash flow.
  //
  // Total cash is a strict superset of current cash: it counts every type of
  // payment (cash money, card payments and broker-balance payments). It is not
  // stored as an independent running total; `total_cash` stores only the two
  // parts that `current_cash` does not already carry, and the total is computed
  // on every read as
  //
  //     TotalCash(branch, currency) = current_cash.CurrentCash
  //                                 + total_cash.CardPart
  //                                 + total_cash.BrokerPart
  //
  // Reading the cash part live from `current_cash` is what makes the identity
  // structural: resetting current cash - or clearing the card balance, which
  // zeroes every CardPart - drags Total cash down automatically.
  await db.query(`
    CREATE TABLE IF NOT EXISTS total_cash (
      id INT NOT NULL,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      CardPart DECIMAL(15,2) NOT NULL DEFAULT 0,
      BrokerPart DECIMAL(15,2) NOT NULL DEFAULT 0,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id, Branch, Currency),
      KEY idx_total_cash_branch (Branch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // Ledger of every movement counted in Total cash, tagged with the channel
  // (Source = Cash | Card | Broker) it came through.
  await db.query(`
    CREATE TABLE IF NOT EXISTS total_cash_transactions (
      id INT NOT NULL AUTO_INCREMENT,
      Branch VARCHAR(45) NOT NULL DEFAULT '',
      Type VARCHAR(20) NOT NULL,
      Amount DECIMAL(15,2) NOT NULL,
      Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
      Source VARCHAR(10) NOT NULL,
      Username VARCHAR(45) NOT NULL,
      Reason VARCHAR(255) NOT NULL,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_total_cash_transactions_branch (Branch),
      KEY idx_total_cash_transactions_source (Source),
      KEY idx_total_cash_transactions_username (Username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  // One-time backfill of the two parts from the policies that already exist, so
  // the superset identity holds for historical data too and not only for
  // payments made after this migration. A non-annulled policy contributed its
  // full price; an annulled one contributed its price and was then refunded
  // (price - fee), so its net contribution is the annul fee.
  //
  // Guarded on an empty `total_cash` so it never overwrites live parts: once the
  // tables are in use, a card reset may legitimately have zeroed CardPart while
  // the policies behind it still exist, and recomputing would resurrect it.
  const [totalCashRows] = await db.query(
    "SELECT COUNT(*) AS n FROM total_cash"
  );
  if (seed && Number(totalCashRows[0].n) === 0) {
    await db.query(`
      INSERT INTO total_cash (id, Branch, Currency, CardPart, BrokerPart)
      SELECT 1, Branch, CurrencyType,
             ROUND(SUM(CASE WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                            ELSE COALESCE(AnnulFee, 0) END), 2),
             0
        FROM insurance
       WHERE PaymentType = 'Card' AND Deleted = 0
       GROUP BY Branch, CurrencyType
      ON DUPLICATE KEY UPDATE CardPart = VALUES(CardPart)
    `);

    // Policies whose sender matched a broker were funded by that broker's
    // balance (email cash payments), so they belong to the Broker part.
    await db.query(`
      INSERT INTO total_cash (id, Branch, Currency, CardPart, BrokerPart)
      SELECT 1, Branch, CurrencyType, 0,
             ROUND(SUM(CASE WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                            ELSE COALESCE(AnnulFee, 0) END), 2)
        FROM insurance
       WHERE BrokerId IS NOT NULL AND PaymentType IN ('Cash', 'Broker') AND Deleted = 0
       GROUP BY Branch, CurrencyType
      ON DUPLICATE KEY UPDATE BrokerPart = VALUES(BrokerPart)
    `);
    console.log("Backfilled total_cash parts from existing insurances");
  }

  // Split the old global card balance into per-branch balances (explicit setup
  // only: see the `seed` switch at the top).
  if (seed) await seedBranchCardBalances(db);

  if (seed) {
    // One-time cleanup: the +2 card tax goes to the bank and is visual-only
    // during policy creation. Strip any previously stored +2 card fee from
    // existing policies' prices and card balances, and clear their CardFee flag
    // so this runs at most once per row.
    const [legacyCardFees] = await db.query(
      `SELECT Branch, COALESCE(CurrencyType, 'EUR') AS Currency,
              COUNT(*) AS ActiveCardCount
         FROM insurance
        WHERE CardFee = 1 AND PaymentType = 'Card' AND Deleted = 0 AND Annulled = 0
        GROUP BY Branch, COALESCE(CurrencyType, 'EUR')`
    );
    for (const row of legacyCardFees || []) {
      const deduction = Number(row.ActiveCardCount) * 2;
      if (deduction > 0) {
        await db.query(
          "UPDATE branch_card_balance SET CardBalance = CardBalance - ? WHERE Branch = ?",
          [deduction, row.Branch || ""]
        );
        await db.query(
          "UPDATE total_cash SET CardPart = CardPart - ? WHERE id = 1 AND Branch = ? AND Currency = ?",
          [deduction, row.Branch || "", row.Currency || "EUR"]
        );
      }
    }
    await db.query(
      `UPDATE insurance
          SET Price = CAST(GREATEST(0, ROUND(CAST(Price AS DECIMAL(15,2)) - 2, 2)) AS CHAR),
              CardFee = 0
        WHERE CardFee = 1`
    );
  }

  // 4b) Create brokers + broker_emails tables.
  await db.query(`
     CREATE TABLE IF NOT EXISTS brokers (
       id INT NOT NULL AUTO_INCREMENT,
       Name VARCHAR(100) NOT NULL,
       Code VARCHAR(50) NULL,
       CashBalance DECIMAL(15,2) NOT NULL DEFAULT 0,
       CutOff TINYINT(1) NOT NULL DEFAULT 0,
       IsSubBroker TINYINT(1) NOT NULL DEFAULT 0,
       PolicyRangeStart INT NOT NULL,
       PolicyRangeEnd INT NOT NULL,
       InactivePolicies INT NOT NULL DEFAULT 0,
       Deleted TINYINT(1) NOT NULL DEFAULT 0,
       DeletedAt DATETIME NULL,
       DeletedBy VARCHAR(45) NULL,
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

  // Broker pricing tariffs (per broker, insurance type, duration)
  await db.query(`
     CREATE TABLE IF NOT EXISTS broker_tariffs (
       id INT NOT NULL AUTO_INCREMENT,
       BrokerId INT NOT NULL,
       InsuranceType VARCHAR(45) NOT NULL,
       Duration INT NOT NULL,
       Price DECIMAL(10,2) NOT NULL,
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_broker_tariff (BrokerId, InsuranceType, Duration),
       KEY idx_broker_tariffs_broker (BrokerId)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
   `);

  // Walk-in pricing for each branch
  await db.query(`
     CREATE TABLE IF NOT EXISTS branch_tariffs (
       id INT NOT NULL AUTO_INCREMENT,
       Branch VARCHAR(100) NOT NULL,
       InsuranceType VARCHAR(45) NOT NULL,
       Duration INT NOT NULL,
       Price DECIMAL(10,2) NOT NULL,
       Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_branch_tariff (Branch, InsuranceType, Duration, Currency),
       KEY idx_branch_tariffs_branch (Branch)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
   `);

  // Managed branch registry. Admins enable/disable branches and create new ones
  // from the dashboard. A disabled branch blocks employee login and blocks the
  // creation of new insurances through it (enforced in the request handlers).
  await db.query(`
     CREATE TABLE IF NOT EXISTS branches (
       id INT NOT NULL AUTO_INCREMENT,
       Name VARCHAR(100) NOT NULL,
       Enabled TINYINT(1) NOT NULL DEFAULT 1,
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_branches_name (Name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
   `);

  // Seed the branches the system already knows about. New branches are created
  // by admins through POST /admin/branches. INSERT IGNORE keeps this idempotent.
  // Only on an explicit setup: a server restart must not recreate a branch an
  // admin renamed or emptied.
  if (seed) {
    const { BranchPricingKeys } = require("./BrokerInfo.js");
    for (const branchName of Object.keys(BranchPricingKeys)) {
      await db.query(
        "INSERT IGNORE INTO branches (Name, Enabled) VALUES (?, 1)",
        [branchName]
      );
    }
  }

  // branch_tariffs now stores a Currency (EUR/TRY) so the Lesovo / Kap
  // Andreevo crossings can quote Auto policies in Turkish lira separately
  // from their EUR walk-in rates. Re-key the unique index for older DBs.
  const [branchTariffCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "branch_tariffs"]
  );
  const branchTariffColNames = new Set(branchTariffCols.map((c) => c.COLUMN_NAME));
  if (!branchTariffColNames.has("Currency")) {
    await db.query("ALTER TABLE branch_tariffs ADD COLUMN Currency VARCHAR(3) NOT NULL DEFAULT 'EUR'");
    await db.query("ALTER TABLE branch_tariffs DROP INDEX uq_branch_tariff");
    await db.query("ALTER TABLE branch_tariffs ADD UNIQUE KEY uq_branch_tariff (Branch, InsuranceType, Duration, Currency)");
    console.log("Added branch_tariffs.Currency column and re-keyed its unique index");
  }

  // Blanc batches handed to brokers: one row per [RangeStart, RangeEnd]
  // batch. A broker's inactive blancs are calculated from all of its batches
  // (see Requests/Brokers.js); brokers.PolicyRangeStart / PolicyRangeEnd /
  // InactivePolicies are legacy and no longer maintained.
  await db.query(`
     CREATE TABLE IF NOT EXISTS broker_blanc_batches (
       id INT NOT NULL AUTO_INCREMENT,
       BrokerId INT NOT NULL,
       RangeStart BIGINT UNSIGNED NOT NULL,
       RangeEnd BIGINT UNSIGNED NOT NULL,
       CreatedBy VARCHAR(45) NOT NULL DEFAULT '',
       AutoAdded TINYINT(1) NOT NULL DEFAULT 0,
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_broker_blanc_batches_broker (BrokerId),
       KEY idx_broker_blanc_batches_range (RangeStart, RangeEnd)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Blanc number ranges handed to brokers (one row per batch)'
   `);

  // A blanc forced in outside every handed-out range joins the broker's batches
  // as its own one-number batch; AutoAdded marks it, so the client paints it
  // pink. Databases created before that column existed get it here.
  {
    const [batchCols] = await db.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [DB_NAME, "broker_blanc_batches"]
    );
    if (!batchCols.some((c) => c.COLUMN_NAME === "AutoAdded")) {
      await db.query(
        "ALTER TABLE broker_blanc_batches ADD COLUMN AutoAdded TINYINT(1) NOT NULL DEFAULT 0"
      );
      console.log("Added broker_blanc_batches.AutoAdded column");
    }
  }

  // Ledger of every change to a broker's CashBalance (signed Amount), so the
  // website can show each broker's balance movement per bi-weekly period.
  await db.query(`
     CREATE TABLE IF NOT EXISTS broker_balance_movements (
       id INT NOT NULL AUTO_INCREMENT,
       BrokerId INT NOT NULL,
       Amount DECIMAL(15,2) NOT NULL,
       Type VARCHAR(30) NOT NULL,
       Reason VARCHAR(255) NOT NULL DEFAULT '',
       Recipient VARCHAR(100) NULL,
       Author VARCHAR(45) NOT NULL DEFAULT '',
       BlancNumber VARCHAR(45) NULL,
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       Deleted TINYINT(1) NOT NULL DEFAULT 0,
       DeletedAt DATETIME NULL,
       DeletedBy VARCHAR(45) NULL,
       Branch VARCHAR(45) NULL,
       Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
       PRIMARY KEY (id),
       KEY idx_broker_movements_broker_time (BrokerId, CreatedAt),
       KEY idx_broker_movements_branch_time (Branch, CreatedAt)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Every change to a broker CashBalance (signed Amount)'
   `);

  // Hand-overs record who received the money ("Received by"). Add the column to
  // pre-existing ledgers BEFORE the payments mirror is backfilled, so the
  // backfill can copy it. Fresh installs already have it in the CREATE above.
  const [movementRecipientCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "broker_balance_movements"]
  );
  if (!movementRecipientCols.some((c) => c.COLUMN_NAME === "Recipient")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN Recipient VARCHAR(100) NULL AFTER Reason"
    );
    console.log("Added broker_balance_movements.Recipient column");
  }

  // A broker's balance is rebuilt from the insurance table and the money the
  // broker actually handed over, so those payments have their own table now
  // (db/brokerPayments.js). The history ledger is only the audit trail; a
  // correction or a soft delete there can no longer move a balance. Create the
  // table and mirror the payments already in the ledger (idempotent).
  try {
    await ensureBrokerPaymentsTable(db);
    const [paymentRecipientCols] = await db.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [DB_NAME, "broker_payments"]
    );
    if (!paymentRecipientCols.some((c) => c.COLUMN_NAME === "Recipient")) {
      await db.query(
        "ALTER TABLE broker_payments ADD COLUMN Recipient VARCHAR(100) NULL AFTER Reason"
      );
      console.log("Added broker_payments.Recipient column");
    }
    const mirrored = seed ? await backfillBrokerPayments(db) : 0;
    if (mirrored) {
      console.log(`Mirrored ${mirrored} broker payment(s) into broker_payments`);
    }
  } catch (err) {
    console.warn(
      "Could not prepare the broker payments table:",
      (err && err.message) || err
    );
  }

  // Link the policies that predate insurance.SaleMovementId to the history row
  // of their sale, so a later blanc correction can never detach the charge.
  if (seed) {
    try {
      const linked = await backfillInsuranceSaleLinks(db);
      if (linked) {
        console.log(`Linked ${linked} insurance(s) to their sale movement`);
      }
    } catch (err) {
      console.warn(
        "Could not link policies to their sale movements:",
        (err && err.message) || err
      );
    }
  }

  // The balance a broker had BEFORE its first insurance (the base the balance
  // history page recalculates from, see recalculateBrokerBalance in
  // Requests/Brokers.js). One row per broker; a broker without a row has no
  // starting balance yet. The server creates it on first use as well, so a
  // database that has not been set up again after the update still works.
  await db.query(`
     CREATE TABLE IF NOT EXISTS broker_starting_balances (
       BrokerId INT NOT NULL,
       Amount DECIMAL(15,2) NOT NULL DEFAULT 0,
       EffectiveDate DATE NOT NULL,
       UpdatedBy VARCHAR(45) NOT NULL DEFAULT '',
       UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (BrokerId)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='The balance a broker had before its first insurance (recalculation base)'
   `);

  // Cash from Brokers: the money brokers hand over when their balance is topped
  // up is kept apart from current cash (see Requests/CurrentCash.js). The
  // balance is computed from the top-ups in broker_balance_movements; this
  // table records each "Reset to 0" of it - who did it, how much was kept per
  // currency, and the last movement the reset covered.
  await db.query(`
     CREATE TABLE IF NOT EXISTS broker_cash_resets (
       id INT NOT NULL AUTO_INCREMENT,
       Branch VARCHAR(45) NOT NULL DEFAULT '',
       Username VARCHAR(45) NOT NULL,
       Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
       KeptAmount DECIMAL(15,2) NOT NULL DEFAULT 0,
       LastMovementId INT NOT NULL DEFAULT 0,
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_broker_cash_resets_branch (Branch),
       KEY idx_broker_cash_resets_username (Username)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Resets of a branch Cash from Brokers (kept amount per currency)'
   `);
  // Bi-weekly bills: what each broker owes for one payment period. The server
  // creates the table on first use as well (db/brokerBills.js), so a database
  // that has not been set up again after the update still works. Billing itself
  // stays off until BILLING_ENABLED=1 (see Mail/brokerBilling.js).
  const billSchema = require("./brokerBills.js");
  await db.query(billSchema.BILL_TABLE_SQL);
  // Columns added after the first version of the table (a deployment that
  // already created it gets them here).
  for (const [name, definition] of billSchema.BILL_EXTRA_COLUMNS) {
    await db
      .query(`ALTER TABLE broker_bills ADD COLUMN ${name} ${definition}`)
      .catch(() => {});
  }

  // Blancs that turned out to be hollow/faulty (no policy can be written on
  // them). A hollow blanc is not a policy: it is recorded here instead of in
  // `insurance`, and it is counted as used-up when a broker's inactive blancs
  // are calculated (Requests/Brokers.js), so it disappears from the broker's
  // current blancs and can never be used for a policy
  // (Requests/TierEndpoints.js rejects it).
  await db.query(`
     CREATE TABLE IF NOT EXISTS hollow_blancs (
       BlancNumber VARCHAR(45) NOT NULL,
       BrokerId INT NULL,
       Branch VARCHAR(45) NOT NULL DEFAULT '',
       Author VARCHAR(45) NOT NULL DEFAULT '',
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (BlancNumber),
       KEY idx_hollow_blancs_broker (BrokerId)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Blanc numbers tagged as hollow (cannot be used for a policy)'
   `);

  // Free-text notes on a policy, with the user who wrote each one. Keyed by the
  // policy's BlancNumber (the insurance table's primary key); a note may also
  // exist for a deleted policy (it is the record of why it was deleted).
  await db.query(`
     CREATE TABLE IF NOT EXISTS insurance_notes (
       id INT NOT NULL AUTO_INCREMENT,
       BlancNumber VARCHAR(45) NOT NULL,
       Note TEXT NOT NULL,
       Author VARCHAR(45) NOT NULL DEFAULT '',
       CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_insurance_notes_blanc (BlancNumber, CreatedAt)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Notes added to an insurance (with the author of each note)'
   `);

  // Global key/value settings (e.g. whether broker requests that would push a
  // broker balance negative are accepted). Keyed by `name` so future toggles
  // reuse the same table without another migration.
  await db.query(`
     CREATE TABLE IF NOT EXISTS app_settings (
       name VARCHAR(100) NOT NULL,
       value VARCHAR(255) NOT NULL DEFAULT '',
       UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
     COMMENT='Global application key/value settings'
   `);



  // Migrate brokers to the current schema on existing databases.
  // - Rename TotalGivenPolicies -> InactivePolicies.
  // - Drop the legacy Percentage column (no percentages; flat fee per policy).
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
  if (brokerColNames.has("Percentage")) {
    await db.query("ALTER TABLE brokers DROP COLUMN Percentage");
    console.log("Dropped brokers.Percentage column");
  }
  await db.query(
    "ALTER TABLE brokers MODIFY COLUMN CashBalance DECIMAL(15,2) NOT NULL DEFAULT 0"
  );

  // Parent broker relationship: a sub-broker ("underling") can be mapped to a
  // main broker. Sub-brokers without their own tariffs inherit the main
  // broker's pricing (see Requests/Brokers.js effectivePricingFor).
  if (!brokerColNames.has("ParentBrokerId")) {
    await db.query(
      "ALTER TABLE brokers ADD COLUMN ParentBrokerId INT NULL, ADD KEY idx_brokers_parent (ParentBrokerId)"
    );
    console.log("Added brokers.ParentBrokerId column");
  }

  // Manual cut-off flag: an admin can block new insurances for a broker (the
  // "cut off" button in the brokers list). Separate from the automatic
  // two-week-behind detection, which now only highlights the row as overdue.
  if (!brokerColNames.has("CutOff")) {
    await db.query(
      "ALTER TABLE brokers ADD COLUMN CutOff TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added brokers.CutOff column");
  }

  // Sub-broker flag: marks brokers flagged as sub-brokers in BrokerInfo.js
  // (or assigned a ParentBrokerId) so they do not see pricing or balance
  // calculations on the website until a main broker is chosen and sets up
  // their price list.
  if (!brokerColNames.has("IsSubBroker")) {
    await db.query(
      "ALTER TABLE brokers ADD COLUMN IsSubBroker TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added brokers.IsSubBroker column");
  }

  // Human-readable broker ID (e.g. "4.2") shown in the client and in Excel
  // exports. Backfilled from BrokerInfo.BrokerCodes below.
  if (!brokerColNames.has("Code")) {
    await db.query("ALTER TABLE brokers ADD COLUMN Code VARCHAR(50) NULL");
    console.log("Added brokers.Code column");
  }

  // Soft-delete support for brokers: an admin can delete a broker from the
  // brokers list. The row is kept (tagged with Deleted/DeletedAt/DeletedBy) so
  // its balance history, blanc batches, emails and linked policies stay intact,
  // and an admin can restore it. A deleted broker is hidden from every list and
  // its addresses stop being recognised as broker senders.
  if (!brokerColNames.has("Deleted")) {
    await db.query(
      "ALTER TABLE brokers ADD COLUMN Deleted TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added brokers.Deleted column");
  }
  if (!brokerColNames.has("DeletedAt")) {
    await db.query("ALTER TABLE brokers ADD COLUMN DeletedAt DATETIME NULL");
    console.log("Added brokers.DeletedAt column");
  }
  if (!brokerColNames.has("DeletedBy")) {
    await db.query("ALTER TABLE brokers ADD COLUMN DeletedBy VARCHAR(45) NULL");
    console.log("Added brokers.DeletedBy column");
  }

  // Backfill the broker IDs for the brokers listed in BrokerInfo.BrokerCodes.
  // Only fills missing/empty codes, so an ID entered by an admin is kept. This
  // is a data step, so it waits for an explicit setup instead of every restart.
  if (seed) {
    const { BrokerCodes } = require("./BrokerInfo.js");
    for (const [name, code] of Object.entries(BrokerCodes)) {
      await db.query(
        "UPDATE brokers SET Code = ? WHERE Name = ? AND (Code IS NULL OR Code = '')",
        [code, name]
      );
    }
  }

  // Soft-delete support on the broker balance ledger: a deleted movement is
  // flagged (Deleted/DeletedAt/DeletedBy) and never physically removed, so an
  // admin can restore it later. Add the columns to pre-existing ledgers; the
  // CREATE above already includes them for fresh installs.
  const [movementCols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, "broker_balance_movements"]
  );
  const movementColNames = new Set(movementCols.map((c) => c.COLUMN_NAME));
  if (!movementColNames.has("Deleted")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN Deleted TINYINT(1) NOT NULL DEFAULT 0"
    );
    console.log("Added broker_balance_movements.Deleted column");
  }
  if (!movementColNames.has("DeletedAt")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN DeletedAt DATETIME NULL"
    );
    console.log("Added broker_balance_movements.DeletedAt column");
  }
  if (!movementColNames.has("DeletedBy")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN DeletedBy VARCHAR(45) NULL"
    );
    console.log("Added broker_balance_movements.DeletedBy column");
  }

  // Cash from Brokers: a manual top-up carries the branch that took the money
  // and its currency. Branch stays NULL on every other movement. Top-ups made
  // before this change were mirrored into current cash and have no branch yet;
  // the separation further down gives them one and takes them out of the drawer.
  if (!movementColNames.has("Branch")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN Branch VARCHAR(45) NULL"
    );
    await db.query(
      "ALTER TABLE broker_balance_movements ADD KEY idx_broker_movements_branch_time (Branch, CreatedAt)"
    );
    console.log("Added broker_balance_movements.Branch column");
  }
  if (!movementColNames.has("Currency")) {
    await db.query(
      "ALTER TABLE broker_balance_movements ADD COLUMN Currency VARCHAR(3) NOT NULL DEFAULT 'EUR'"
    );
    console.log("Added broker_balance_movements.Currency column");
  }

  // Cash from Brokers: broker top-ups recorded before the split above were also
  // mirrored into current cash, so they still count as Available cash. Take them
  // out of the drawer once (see db/separateBrokerCash.js). The migration is
  // transactional and marks itself in `app_settings`; a failure rolls it back and
  // is retried on the next start, so setup carries on either way.
  if (seed) {
    try {
      await db.beginTransaction();
      let separated;
      try {
        separated = await separateBrokerCash(db, { log: console.warn });
        await db.commit();
      } catch (err) {
        await db.rollback();
        throw err;
      }
      if (separated.ran) {
        const detail = separated.groups
          .map((g) => `${g.Branch || "(no branch)"} ${g.Currency} ${g.Amount}`)
          .join(", ");
        console.log(
          `Separated ${separated.pairs} broker top-up(s) from current cash` +
            (detail ? `: ${detail}` : "")
        );
      }
    } catch (err) {
      console.warn(
        "Could not separate past broker top-ups from current cash:",
        (err && err.message) || err
      );
    }
  }

  // One-time backfill of the broker balance ledger from existing insurances,
  // so historical bi-weekly reports already show balance movement. Only runs
  // when the ledger is empty, so a later restart never double-counts. Manual
  // increases/reduces that predate the ledger cannot be reconstructed.
  const [[{ n: movementCount }]] = await db.query(
    "SELECT COUNT(*) AS n FROM broker_balance_movements"
  );
  if (seed && Number(movementCount) === 0) {
    // Creation deducts the policy price from the broker's balance. An annulled
    // policy's Price is its annulment tax, so the original sale price is used.
    await db.query(`
      INSERT INTO broker_balance_movements
        (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
      SELECT BrokerId, -CAST(COALESCE(OriginalPrice, Price) AS DECIMAL(15,2)), 'policy',
             CONCAT('Insurance ', BlancNumber), COALESCE(Author, ''),
             BlancNumber, CreationDate
        FROM insurance
       WHERE BrokerId IS NOT NULL
    `);
    // An annulment refunds the original price (minus the fee when the broker was
    // at fault, stored in AnnulReason = 'broker').
    await db.query(`
      INSERT INTO broker_balance_movements
        (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
      SELECT BrokerId,
             ROUND(CASE WHEN AnnulReason = 'broker'
                   THEN CAST(COALESCE(OriginalPrice, Price) AS DECIMAL(15,2))
                      - COALESCE(CAST(AnnulFee AS DECIMAL(15,2)), 0)
                   ELSE CAST(COALESCE(OriginalPrice, Price) AS DECIMAL(15,2)) END, 2),
             'annulment',
             CONCAT('Annul ', BlancNumber), COALESCE(AnnulBy, ''),
             BlancNumber, AnnulDate
        FROM insurance
       WHERE BrokerId IS NOT NULL AND Annulled = 1
    `);
    // A deletion refunds the full price only when the policy was not already
    // annulled (an annulment would already have refunded it).
    await db.query(`
      INSERT INTO broker_balance_movements
        (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
      SELECT BrokerId, CAST(COALESCE(OriginalPrice, Price) AS DECIMAL(15,2)), 'deletion',
             CONCAT('Delete ', BlancNumber), COALESCE(DeletedBy, ''),
             BlancNumber, DeletedAt
        FROM insurance
       WHERE BrokerId IS NOT NULL AND Deleted = 1 AND Annulled = 0
    `);
    console.log("Backfilled broker_balance_movements from existing insurances");
  }

  // Re-apply the broker balance formula on an explicit setup for every broker
  // that has a starting balance (see recalculateBrokerBalance in
  // Requests/Brokers.js):
  //
  //   CashBalance = starting balance
  //               + payments from broker_payments
  //               - live policies (an annulled one at its tax ONLY when the
  //                 broker paid it, AnnulReason = 'broker')
  //               - voided policy charges (hidden policy-derived ledger rows of
  //                 policies that still exist)
  //
  // This makes a corrected rule reach brokers whose balance was stored under an
  // older one (e.g. the annulment tax charged even when the worker paid it).
  // Brokers without a starting balance keep their stored figure: that is the
  // only base they have. The statement is idempotent and runs only on brokers
  // with a stored starting balance. It is a data step, so a plain restart does
  // not touch any balance.
  if (seed) {
    try {
      const [recalculated] = await db.query(`
      UPDATE brokers b
      JOIN broker_starting_balances sb ON sb.BrokerId = b.id
      SET b.CashBalance = ROUND(
        sb.Amount
        + COALESCE((
            SELECT SUM(p.Amount)
              FROM broker_payments p
             WHERE p.BrokerId = b.id AND p.Deleted = 0
               AND p.Type IN ('increase', 'handover')
          ), 0)

        - COALESCE((
            SELECT SUM(CASE
                         WHEN i.Annulled = 0
                         THEN CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2))
                         WHEN LOWER(TRIM(COALESCE(i.AnnulReason, ''))) = 'broker'
                         THEN CAST(COALESCE(i.AnnulFee, i.Price, 0) AS DECIMAL(15,2))
                         ELSE 0
                       END)
              FROM insurance i
             WHERE i.BrokerId = b.id AND i.Deleted = 0
          ), 0)

        - COALESCE((
            SELECT SUM(m.Amount)
              FROM broker_balance_movements m
              JOIN insurance vi
                ON vi.BrokerId = m.BrokerId AND vi.BlancNumber = m.BlancNumber
               AND vi.Deleted = 0
             WHERE m.BrokerId = b.id AND m.Deleted = 1
               AND m.Type IN ('policy', 'price_change', 'annulment', 'deletion')
          ), 0), 2)
    `);
      if (recalculated && recalculated.affectedRows) {
        console.log(
          `Re-applied the starting-balance formula to ${recalculated.affectedRows} broker(s)`
        );
      }
    } catch (err) {
      console.warn(
        "Could not re-apply the broker starting-balance formula:",
        (err && err.message) || err
      );
    }
  }


  await db.query(`
    CREATE TABLE IF NOT EXISTS client_diagnostics (
      id BIGINT NOT NULL AUTO_INCREMENT,
      ReceivedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ClientId VARCHAR(80) NULL,
      Username VARCHAR(45) NULL,
      AuthState VARCHAR(8) NULL,
      Kind VARCHAR(24) NOT NULL DEFAULT 'failure',
      Status INT NULL,
      Method VARCHAR(12) NULL,
      Path VARCHAR(700) NULL,
      Url VARCHAR(1500) NULL,
      RequestId VARCHAR(80) NULL,
      HasRequestId TINYINT(1) NOT NULL DEFAULT 0,
      CapturedAt DATETIME NULL,
      CapturedAtMs BIGINT NULL,
      CapturedAtText VARCHAR(40) NULL,
      DurationMs INT NULL,
      Attempt INT NULL,
      RepeatCount INT NOT NULL DEFAULT 1,
      PairId VARCHAR(80) NULL,
      SamePath TINYINT(1) NULL,
      Origin VARCHAR(300) NULL,
      UploadIp VARCHAR(64) NULL,
      ForwardedFor VARCHAR(512) NULL,
      UserAgent VARCHAR(512) NULL,
      Body MEDIUMTEXT NULL,
      Headers JSON NULL,
      RequestHeaders JSON NULL,
      Env JSON NULL,
      Extra JSON NULL,
      UploadHeaders JSON NULL,
      UploadOrigin VARCHAR(300) NULL,
      PRIMARY KEY (id),
      KEY idx_client_diagnostics_received (ReceivedAt),
      KEY idx_client_diagnostics_client (ClientId),
      KEY idx_client_diagnostics_status (Status),
      KEY idx_client_diagnostics_kind (Kind),
      KEY idx_client_diagnostics_request (RequestId),
      KEY idx_client_diagnostics_ip (UploadIp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  console.log("Database setup complete.");

  await db.end();
}

/**
 * Link every policy that has no link yet to the history row of its sale.
 *
 * The sale row is the oldest live `policy` movement of the same broker and blanc
 * (row ids grow with time and a restore writes a newer charge); it is the row the
 * history page already shows for the policy. Linking it changes no money - it
 * only makes the pairing independent of the blanc, so a later blanc correction
 * cannot detach the charge. A policy with no live sale row (a void, a missing row
 * or a row left under an older blanc) stays NULL until
 * `db/repair-broker-ledger.js` (or the SQL in Insurance/migrations) puts it right.
 *
 * Idempotent: it only fills SaleMovementId where it is still NULL, and the
 * unique key makes a second run a no-op.
 *
 * @param {{query: Function}} db
 * @returns {Promise<number>} rows linked
 */
async function backfillInsuranceSaleLinks(db) {
  const [result] = await db.query(
    `UPDATE insurance i
       JOIN (
             SELECT i2.BlancNumber, MIN(m.id) AS MovementId
               FROM insurance i2
               JOIN broker_balance_movements m
                 ON m.BrokerId = i2.BrokerId
                AND m.BlancNumber = i2.BlancNumber
                AND m.Type = 'policy'
                AND m.Deleted = 0
              WHERE i2.BrokerId IS NOT NULL AND i2.SaleMovementId IS NULL
              GROUP BY i2.BlancNumber
            ) sale ON sale.BlancNumber = i.BlancNumber
        SET i.SaleMovementId = sale.MovementId
      WHERE i.SaleMovementId IS NULL`
  );
  return Number(result && result.affectedRows) || 0;
}

module.exports = { runSetup, backfillInsuranceSaleLinks };

// Allow `npm run db:setup` to run this file directly.
if (require.main === module) {
  runSetup().catch((err) => {
    console.error("Database setup failed:", err);
    process.exitCode = 1;
  });
}

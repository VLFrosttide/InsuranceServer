"use strict";

// Broker payments - the money a broker actually handed over.
//
// A broker's balance is rebuilt from source data (see recalculateBrokerBalance
// in Requests/Brokers.js):
//
//   CashBalance = starting balance
//               + every payment in broker_payments
//               - every live insurance (an annulled one at its tax)
//               - every voided policy charge (a hidden policy-derived row)
//
// Payments used to be read back from `broker_balance_movements` (the history
// ledger). That table is a JOURNAL: an admin may correct an amount or
// soft-delete a row from the balance history page, and every policy charge is
// stored there again as a duplicate of its insurance row. Deriving money from
// it meant a cosmetic correction could move the balance and a missing row could
// hide a payment. The payment money therefore lives here, in its own table,
// while the ledger stays what it is: the audit trail of who did what, when.
// The only thing the balance takes from the ledger is the set of VOIDS: a
// policy-derived row of a live policy that an admin soft-deleted stops being
// charged (a soft-deleted insurance is charged nothing and all its rows are
// skipped). See recalculateBrokerBalance.
//
// Every payment is still written to the ledger as well, in the same
// transaction, so the history page, "Cash from Brokers" and the reports keep
// working unchanged; `MovementId` ties the two rows together and makes the
// startup backfill idempotent.

// "increase" is a branch top-up (a paid bill is an increase too); "handover" is
// money the broker paid the owner directly.
const PAYMENT_TYPES = ["increase", "handover"];

const BROKER_PAYMENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS broker_payments (
    id INT NOT NULL AUTO_INCREMENT,
    BrokerId INT NOT NULL,
    Amount DECIMAL(15,2) NOT NULL,
    Type VARCHAR(30) NOT NULL DEFAULT 'increase',
    Reason VARCHAR(255) NOT NULL DEFAULT '',
    Recipient VARCHAR(100) NULL,
    Author VARCHAR(45) NOT NULL DEFAULT '',
    Branch VARCHAR(45) NULL,
    Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    CreatedAt DATETIME NOT NULL,
    MovementId INT NULL COMMENT 'broker_balance_movements row of the same payment',
    Deleted TINYINT(1) NOT NULL DEFAULT 0,
    DeletedAt DATETIME NULL,
    DeletedBy VARCHAR(45) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY unique_broker_payment_movement (MovementId),
    KEY idx_broker_payments_broker (BrokerId, CreatedAt),
    KEY idx_broker_payments_branch (Branch, CreatedAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Money a broker handed over (the balance formula reads this)'
`;

/** Whether a movement type is money the broker paid (as opposed to a charge). */
function isPaymentType(type) {
  return PAYMENT_TYPES.includes(String(type || "").trim());
}

/**
 * Create `broker_payments` if it does not exist yet. Safe to call often: the
 * CREATE is idempotent and the server also runs it on start-up (db/setup.js).
 *
 * @param {{query: Function}} db  Pool or connection.
 */
async function ensureBrokerPaymentsTable(db) {
  await db.query(BROKER_PAYMENTS_TABLE_SQL);
}

/**
 * Mirror every payment already recorded in the history ledger into
 * `broker_payments`. Runs on start-up: rows written before this table existed
 * (or by a server that failed halfway) are picked up once. The unique index on
 * `MovementId` makes a second run a no-op, so nothing is ever counted twice.
 *
 * @param {{query: Function}} db  Pool or connection.
 * @returns {Promise<number>} How many payments were mirrored.
 */
async function backfillBrokerPayments(db) {
  const [result] = await db.query(
    `INSERT INTO broker_payments
       (BrokerId, Amount, Type, Reason, Recipient, Author, Branch, Currency,
        CreatedAt, MovementId, Deleted, DeletedAt, DeletedBy)
     SELECT m.BrokerId, m.Amount, m.Type, m.Reason, m.Recipient, m.Author,
            m.Branch, COALESCE(m.Currency, 'EUR'), m.CreatedAt, m.id,
            m.Deleted, m.DeletedAt, m.DeletedBy
       FROM broker_balance_movements m
       LEFT JOIN broker_payments p ON p.MovementId = m.id
      WHERE m.Type IN ('increase', 'handover') AND p.id IS NULL`
  );
  return Number(result && result.affectedRows) || 0;
}

/**
 * Record money the broker paid.
 *
 * Writes the history row (`broker_balance_movements`, the audit trail every
 * report and the balance history page read) AND the payment row the balance
 * formula reads, inside the caller's transaction so the two can never disagree.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} amount  Positive amount handed over.
 * @param {string} type  "increase" (branch top-up / paid bill) or "handover".
 * @param {{reason?: string, recipient?: string, author?: string,
 *          createdAt?: string, branch?: string, currency?: string}} [meta]
 * @returns {Promise<{id: number, amount: number}>} The ledger row id + amount.
 */
async function recordBrokerPayment(conn, brokerId, amount, type, meta = {}) {
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (amt === 0) return { id: null, amount: 0 };

  const branch = typeof meta.branch === "string" ? meta.branch.trim() : null;
  // Who received a hand-over the broker paid directly (the owner, usually).
  // Every other payment is money a branch took, so it has no recipient.
  const recipient =
    typeof meta.recipient === "string" && meta.recipient.trim()
      ? meta.recipient.trim()
      : null;
  const currency =
    String(meta.currency || "EUR")
      .trim()
      .toUpperCase()
      .slice(0, 3) || "EUR";

  // The same row the history page lists. Kept in step with the payment below;
  // CurrentCash.js reads the branch-carrying ones as "Cash from Brokers".
  const [movement] = await conn.query(
    `INSERT INTO broker_balance_movements
       (BrokerId, Amount, Type, Reason, Recipient, Author, BlancNumber,
        CreatedAt, Branch, Currency)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      brokerId,
      amt,
      type,
      String(meta.reason ?? ""),
      recipient,
      String(meta.author ?? ""),
      meta.createdAt || null,
      branch,
      currency,
    ]
  );

  const movementId = movement && movement.insertId ? movement.insertId : null;
  await conn.query(
    `INSERT INTO broker_payments
       (BrokerId, Amount, Type, Reason, Recipient, Author, Branch, Currency,
        CreatedAt, MovementId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?)`,
    [
      brokerId,
      amt,
      type,
      String(meta.reason ?? ""),
      recipient,
      String(meta.author ?? ""),
      branch,
      currency,
      meta.createdAt || null,
      movementId,
    ]
  );

  return { id: movementId, amount: amt };
}

/**
 * Keep the payment mirror in step when an admin corrects, deletes or restores a
 * payment row from the balance history page. A movement that is not (or is no
 * longer) a payment simply has no live mirror row; flipping it into a payment
 * type creates one.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {Object} change
 * @param {number} change.brokerId
 * @param {number} change.movementId
 * @param {string} [change.type]        The movement's type after the change.
 * @param {number|string} [change.amount]
 * @param {string} [change.reason]
 * @param {string} [change.recipient]   Who received a hand-over.
 * @param {string} [change.author]
 * @param {string} [change.createdAt]
 * @param {string} [change.branch]
 * @param {string} [change.currency]
 * @param {boolean} [change.deleted]
 * @param {string} [change.deletedBy]
 */
async function syncBrokerPaymentFromMovement(conn, change = {}) {
  const movementId = Number(change.movementId);
  if (!Number.isInteger(movementId) || movementId <= 0) return;

  const [[existing]] = await conn.query(
    "SELECT id FROM broker_payments WHERE MovementId = ?",
    [movementId]
  );

  if (!isPaymentType(change.type)) {
    // A row that is no longer a payment must not count as money paid.
    if (existing) {
      await conn.query(
        "UPDATE broker_payments SET Deleted = 1, DeletedAt = ?, DeletedBy = ? WHERE id = ?",
        [new Date(), String(change.deletedBy || ""), existing.id]
      );
    }
    return;
  }

  const amount = Math.round((Number(change.amount) || 0) * 100) / 100;
  const recipient =
    typeof change.recipient === "string" && change.recipient.trim()
      ? change.recipient.trim()
      : null;
  if (!existing) {
    await conn.query(
      `INSERT INTO broker_payments
         (BrokerId, Amount, Type, Reason, Recipient, Author, Branch, Currency,
          CreatedAt, MovementId, Deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?)`,
      [
        Number(change.brokerId),
        amount,
        String(change.type),
        String(change.reason ?? ""),
        recipient,
        String(change.author ?? ""),
        change.branch === undefined ? null : change.branch,
        String(change.currency || "EUR").toUpperCase().slice(0, 3) || "EUR",
        change.createdAt || null,
        movementId,
        change.deleted ? 1 : 0,
      ]
    );
    return;
  }

  await conn.query(
    `UPDATE broker_payments
        SET Amount = ?, Type = ?, Reason = COALESCE(?, Reason),
            Recipient = COALESCE(?, Recipient),
            Author = COALESCE(?, Author),
            CreatedAt = COALESCE(?, CreatedAt),
            Deleted = ?, DeletedAt = ?, DeletedBy = ?
      WHERE id = ?`,
    [
      amount,
      String(change.type),
      change.reason === undefined ? null : String(change.reason),
      recipient,
      change.author === undefined ? null : String(change.author),
      change.createdAt || null,
      change.deleted ? 1 : 0,
      change.deleted ? new Date() : null,
      change.deleted ? String(change.deletedBy || "") : null,
      existing.id,
    ]
  );
}

/**
 * Money the broker paid that counts towards the balance (live rows only).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @returns {Promise<number>}
 */
async function sumBrokerPayments(conn, brokerId) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(Amount), 0) AS Paid
       FROM broker_payments
      WHERE BrokerId = ? AND Deleted = 0
        AND Type IN ('increase', 'handover')`,
    [brokerId]
  );
  return Math.round((Number(row && row.Paid) || 0) * 100) / 100;
}

module.exports = {
  PAYMENT_TYPES,
  BROKER_PAYMENTS_TABLE_SQL,
  isPaymentType,
  ensureBrokerPaymentsTable,
  backfillBrokerPayments,
  recordBrokerPayment,
  syncBrokerPaymentFromMovement,
  sumBrokerPayments,
};

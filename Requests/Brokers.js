"use strict";
// Broker balance support.
//
// Each broker has a cash balance that only admins (role 1) and workers
// (role 2) can increase/reduce. Unlike daily current cash, a broker balance
// may go infinitely negative.
//
// Current cash and broker balance are intentionally asymmetric:
//   - Increasing a broker's balance mirrors the same amount into current
//     cash (money is actually coming in), so current cash goes up too.
//   - Reducing a broker's balance (including the per-policy deduction made
//     when an insurance is created from an email card, see
//     decreaseBrokerForInsurance below) never touches current cash. Current
//     cash must never decrease as a side effect of a broker balance
//     reduction, and a broker reduction must never be blocked by how much
//     current cash happens to be available.
//
// Creating an insurance whose email sender is associated with a broker
// deducts a flat fee (the policy price) from that broker's balance. No
// percentages are involved.
//
// Blanc batches: admins hand blancs (blank policy forms) to a broker in
// batches, each one a numeric range [RangeStart, RangeEnd] stored in
// `broker_blanc_batches`. A broker may hold any number of batches. The
// broker's inactive (unused) blancs are NOT a stored counter - they are
// calculated on every read from all of its batch ranges:
//
//     InactivePolicies = sum of (RangeEnd - RangeStart + 1)     (all batches)
//                      - blancs in those ranges used by a non-deleted
//                        insurance (Deleted = 0)
//
// An annulled policy keeps its blanc used up (it is not given back); only a
// deletion gives the blanc back. Batches may never overlap - not within one
// broker and not across brokers - so a blanc belongs to at most one batch.
// The legacy brokers.PolicyRangeStart / PolicyRangeEnd / InactivePolicies
// columns are no longer read or maintained.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { Pricing, seedBrokerTariffsIfMissing } = require("../db/BrokerInfo.js");
const {
  toDecimal,
  recordCashMovement,
  normalizeCurrency,
  normalizeBranch,
  clientLocalDateTime,
  parseClientDateTime,
} = require("./CurrentCash.js");
const { getSchedule } = require("./PaymentSchedule.js");

/**
 * Parse and validate a positive amount (returns null when invalid).
 * @param {number|string} value
 * @returns {number|null}
 */
function parsePositiveAmount(value) {
  const n = toDecimal(value);
  if (n === null || n <= 0) return null;
  return n;
}

/**
 * Resolve the CreatedAt for a new broker-balance movement from a request body:
 * the client's own wall-clock time is stored as sent, otherwise the server
 * clock shifted by the client's TzOffset (UTC when that is missing too).
 * Mirrors CurrentCash.resolveRequestCreatedAt so broker movements are stamped
 * like every other ledger row.
 *
 * @param {object} [body]
 * @returns {{createdAt: string}|{error: string}}
 */
function resolveBrokerCreatedAt(body) {
  const b = body || {};
  const sent = b.CreatedAt ?? b.createdAt;
  if (sent !== undefined && sent !== null && sent !== "") {
    const parsed = parseClientDateTime(sent);
    if (!parsed) {
      return { error: "CreatedAt must be in YYYY-MM-DD HH:MM:SS format" };
    }
    return { createdAt: parsed };
  }
  return { createdAt: clientLocalDateTime(b.TzOffset ?? b.tzOffset ?? null) };
}

/**
 * Resolve the broker that an insurance belongs to.
 *
 * Order of resolution:
 *   1. An explicit BrokerId.
 *   2. A broker with a blanc batch whose range contains the blanc number.
 *   3. The single broker, if exactly one exists.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {{blancNumber?: any, brokerId?: any}} insurance
 * @returns {Promise<number|null>}
 */
const resolveBrokerId = (module.exports.resolveBrokerId =
  async function resolveBrokerId(conn, insurance = {}) {
    const { blancNumber, brokerId } = insurance;

    if (brokerId !== undefined && brokerId !== null && brokerId !== "") {
      const id = Number(brokerId);
      if (Number.isFinite(id) && id > 0) {
        const [rows] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
          id,
        ]);
        if (rows.length) return rows[0].id;
      }
    }

    const numeric = parseInt(String(blancNumber ?? ""), 10);
    if (Number.isFinite(numeric)) {
      const [rows] = await conn.query(
        `SELECT BrokerId AS id FROM broker_blanc_batches
          WHERE RangeStart <= ? AND RangeEnd >= ?
          ORDER BY id LIMIT 1`,
        [numeric, numeric]
      );
      if (rows.length) return rows[0].id;
    }

    const [rows] = await conn.query("SELECT id FROM brokers ORDER BY id");
    return rows.length === 1 ? rows[0].id : null;
  });

/**
 * Resolve the broker that an insurance belongs to from the sender of the
 * incoming email.
 *
 * The insurance form no longer asks the worker to pick a broker. Instead the
 * broker is inferred from the "From" address of the unread email the policy is
 * created from: the address must match a row in `broker_emails`, which links
 * back to a `brokers.id`. Accepts both a bare address and a "Name <address>"
 * header value.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {string} [email]
 * @returns {Promise<{id: number, name: string}|null>} The broker id + name, or
 *   null when the email does not match any broker.
 */
const resolveBrokerByEmail = (module.exports.resolveBrokerByEmail =
  async function resolveBrokerByEmail(conn, email) {
    const raw = String(email ?? "").trim();
    if (!raw) return null;
    let address = raw;
    const m = raw.match(/<([^>]+)>/);
    if (m) address = m[1].trim();
    const [rows] = await conn.query(
      `SELECT be.BrokerId, b.Name
         FROM broker_emails be
         JOIN brokers b ON b.id = be.BrokerId
        WHERE LOWER(be.Email) = LOWER(?)
        ORDER BY be.id
        LIMIT 1`,
      [address]
    );
    if (!rows.length) return null;
    return { id: rows[0].BrokerId, name: rows[0].Name };
  });

/**
 * Deduct the flat fee (the policy price) from a broker's balance. The balance
 * is allowed to go negative. Runs inside the caller's transaction.
 *
 * The broker's inactive blancs are not touched here: they are calculated from
 * the blanc batches, and the new insurance row itself marks its blanc as used.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} price
 * @returns {Promise<number|null>} The charge applied, or null if broker missing.
 */
const decreaseBrokerForInsurance = (module.exports.decreaseBrokerForInsurance =
  async function decreaseBrokerForInsurance(conn, brokerId, price, meta = {}) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
      [priceNum, brokerId]
    );

    await recordBrokerMovement(conn, brokerId, -priceNum, "policy", meta);

    return priceNum;
  });

/**
 * Restore a broker's balance after an insurance policy linked to it is
 * annulled: increases CashBalance by the full price (the money side of the
 * inverse of {@link decreaseBrokerForInsurance}).
 *
 * The blanc of an annulled policy stays used up and is not given back to the
 * broker: annulled (non-deleted) policies still count as using their blanc
 * when inactive blancs are calculated. Only a deletion gives the blanc back
 * (see {@link restoreBrokerForDeletion}). Runs inside the caller's
 * transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} price
 * @returns {Promise<number|null>} The amount restored, or null if broker missing.
 */
const restoreBrokerForAnnulment = (module.exports.restoreBrokerForAnnulment =
  async function restoreBrokerForAnnulment(conn, brokerId, price, meta = {}) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
      [priceNum, brokerId]
    );

    await recordBrokerMovement(conn, brokerId, priceNum, "annulment", meta);

    return priceNum;
  });

/**
 * Undo a policy's effect on its broker when the policy is deleted: refunds
 * `amount` to CashBalance - the money side of the inverse of
 * {@link decreaseBrokerForInsurance}. The blanc is given back on its own: a
 * deleted policy no longer counts as using a blanc when the inactive blancs
 * are calculated from the broker's batches.
 *
 * `amount` is normally the full price. For a policy that was annulled before
 * being deleted the annulment already refunded the price, so the caller
 * passes 0 and nothing is refunded (the blanc is still given back). Runs
 * inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} amount
 * @returns {Promise<number|null>} The amount refunded, or null if broker missing.
 */
const restoreBrokerForDeletion = (module.exports.restoreBrokerForDeletion =
  async function restoreBrokerForDeletion(conn, brokerId, amount, meta = {}) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const amountNum = Math.max(0, toDecimal(amount) || 0);

    if (amountNum > 0) {
      await conn.query(
        "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
        [amountNum, brokerId]
      );
      await recordBrokerMovement(conn, brokerId, amountNum, "deletion", meta);
    }

    return amountNum;
  });

/**
 * Re-sync a broker's balance after the price of a policy linked to it is
 * corrected: applies the difference between the new and the old price to
 * CashBalance (the policy is still active and still uses its blanc, only its
 * price changed). A positive delta charges the broker more, a negative
 * one refunds part of the fee. Runs inside the caller's transaction.
 *
 * This matters because an insurance created from a broker's email is funded
 * entirely by the broker's balance - it never touches current cash - so that
 * balance is the only record of the payment and has to follow price corrections.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} delta  newPrice - oldPrice (may be negative or 0).
 * @returns {Promise<number|null>} The delta applied, or null if broker missing.
 */
const adjustBrokerForPriceChange = (module.exports.adjustBrokerForPriceChange =
  async function adjustBrokerForPriceChange(conn, brokerId, delta, meta = {}) {
    const d = toDecimal(delta) || 0;
    if (d === 0) return 0;

    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
      [d, brokerId]
    );

    await recordBrokerMovement(conn, brokerId, -d, "price_change", meta);

    return d;
  });

// ---------------------------------------------------------------------------
// Broker balance ledger.
// ---------------------------------------------------------------------------
// `broker_balance_movements` records every change to a broker's CashBalance so
// the website can show each broker's balance movement per bi-weekly period.
// `Amount` is signed: positive increases the balance, negative decreases it.
// Policy-derived rows also carry the policy's BlancNumber; manual rows leave
// it NULL.

const BROKER_MOVEMENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS broker_balance_movements (
  id INT NOT NULL AUTO_INCREMENT,
  BrokerId INT NOT NULL,
  Amount DECIMAL(15,2) NOT NULL,
  Type VARCHAR(30) NOT NULL,
  Reason VARCHAR(255) NOT NULL DEFAULT '',
  Author VARCHAR(45) NOT NULL DEFAULT '',
  BlancNumber VARCHAR(45) NULL,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Deleted TINYINT(1) NOT NULL DEFAULT 0,
  DeletedAt DATETIME NULL,
  DeletedBy VARCHAR(45) NULL,
  PRIMARY KEY (id),
  KEY idx_broker_movements_broker_time (BrokerId, CreatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Every change to a broker CashBalance (signed Amount)'`;
module.exports.BROKER_MOVEMENT_TABLE_SQL = BROKER_MOVEMENT_TABLE_SQL;

/**
 * Insert one signed broker-balance movement. Runs inside the caller's
 * transaction (`conn`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} amount  signed delta (positive = increase)
 * @param {string} type  e.g. "policy" | "annulment" | "deletion" |
 *                       "price_change" | "increase" | "reduce" | "adjust"
 * @param {{reason?: string, author?: string, blancNumber?: string,
 *          createdAt?: string}} [meta]  `createdAt` is an already-resolved
 *          client-local "YYYY-MM-DD HH:MM:SS" string.
 * @returns {Promise<number>} the (rounded) amount recorded, or 0 if skipped.
 */
const recordBrokerMovement = (module.exports.recordBrokerMovement =
  async function recordBrokerMovement(conn, brokerId, amount, type, meta = {}) {
    const amt = Math.round((toDecimal(amount) || 0) * 100) / 100;
    if (amt === 0) return 0;
    // Store the client's local wall-clock time when a caller resolved it (a
    // validated "YYYY-MM-DD HH:MM:SS" string); otherwise fall back to the
    // server's UTC clock — the value the old DEFAULT CURRENT_TIMESTAMP used.
    let createdAt = clientLocalDateTime(null);
    if (typeof meta.createdAt === "string") {
      const parsed = parseClientDateTime(meta.createdAt);
      if (parsed) createdAt = parsed;
    }
    await conn.query(
      `INSERT INTO broker_balance_movements
         (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        brokerId,
        amt,
        type,
        String(meta.reason ?? ""),
        String(meta.author ?? ""),
        meta.blancNumber ? String(meta.blancNumber) : null,
        createdAt,
      ]
    );
    return amt;
  });

// Bi-weekly bucketing: a fixed 14-day grid anchored to Monday 2020-01-06.
const DAY_MS = 86400000;
const BIWEEK_EPOCH = Date.UTC(2020, 0, 6);

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

const biweekStart = (module.exports.biweekStart = function biweekStart(value) {
  const d = toDateOnly(value);
  if (!d) return null;
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const weekStart = d.getTime() - daysSinceMonday * DAY_MS;
  const weeks = Math.floor((weekStart - BIWEEK_EPOCH) / (7 * DAY_MS));
  const biweek = Math.floor(weeks / 2);
  return new Date(BIWEEK_EPOCH + biweek * 14 * DAY_MS);
});

const biweekKey = (module.exports.biweekKey = function biweekKey(value) {
  const s = biweekStart(value);
  return s ? s.toISOString().slice(0, 10) : null;
});

/**
 * Whether a broker is cut off for an unpaid balance: their balance was already
 * negative at the start of the current payment period and is still negative
 * now (i.e. they missed the last payment and have not paid it off).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} currentBalance
 * @param {{periodStart: string}} schedule
 * @returns {Promise<boolean>}
 */
const resolveBrokerCutOff = (module.exports.resolveBrokerCutOff =
  async function resolveBrokerCutOff(conn, brokerId, currentBalance, schedule) {
    const balance = Number(currentBalance) || 0;
    if (balance >= 0) return false;

    const [[{ since }]] = await conn.query(
      `SELECT COALESCE(SUM(Amount), 0) AS since
         FROM broker_balance_movements
        WHERE BrokerId = ? AND CreatedAt >= ? AND Deleted = 0`,
      [brokerId, `${schedule.periodStart} 00:00:00`]
    );
    const balanceAtPeriodStart = balance - Number(since);
    return balanceAtPeriodStart < 0;
  });

// ---------------------------------------------------------------------------
// Blanc batches
// ---------------------------------------------------------------------------

const BLANC_BATCH_TABLE_SQL = `CREATE TABLE IF NOT EXISTS broker_blanc_batches (
  id INT NOT NULL AUTO_INCREMENT,
  BrokerId INT NOT NULL,
  RangeStart BIGINT UNSIGNED NOT NULL,
  RangeEnd BIGINT UNSIGNED NOT NULL,
  CreatedBy VARCHAR(45) NOT NULL DEFAULT '',
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_broker_blanc_batches_broker (BrokerId),
  KEY idx_broker_blanc_batches_range (RangeStart, RangeEnd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Blanc number ranges handed to brokers (one row per batch)'`;
module.exports.BLANC_BATCH_TABLE_SQL = BLANC_BATCH_TABLE_SQL;

/**
 * Validate one batch from a request body.
 *
 * @param {object} raw  { RangeStart, RangeEnd } (other casings accepted)
 * @returns {{ok: true, RangeStart: number, RangeEnd: number} | {ok: false, error: string}}
 */
const parseBlancBatch = (module.exports.parseBlancBatch =
  function parseBlancBatch(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const read = (...keys) => {
      for (const k of keys) {
        const v = src[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          return String(v).trim();
        }
      }
      return null;
    };
    const startRaw = read("RangeStart", "rangeStart", "PolicyRangeStart", "policyRangeStart");
    const endRaw = read("RangeEnd", "rangeEnd", "PolicyRangeEnd", "policyRangeEnd");
    if (startRaw === null || endRaw === null) {
      return { ok: false, error: "RangeStart and RangeEnd are required" };
    }
    if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) {
      return {
        ok: false,
        error: "RangeStart and RangeEnd must be non-negative whole numbers",
      };
    }
    const RangeStart = Number(startRaw);
    const RangeEnd = Number(endRaw);
    if (!Number.isSafeInteger(RangeStart) || !Number.isSafeInteger(RangeEnd)) {
      return { ok: false, error: "RangeStart / RangeEnd is too large" };
    }
    if (RangeEnd < RangeStart) {
      return { ok: false, error: "RangeEnd must be >= RangeStart" };
    }
    return { ok: true, RangeStart, RangeEnd };
  });

/**
 * Find the first batch in `batches` whose range overlaps `candidate`.
 *
 * @param {Array<{id?: any, RangeStart: any, RangeEnd: any}>} batches
 * @param {{RangeStart: number, RangeEnd: number}} candidate
 * @param {any} [ignoreId] Batch id to skip (the batch being edited).
 * @returns {object|null}
 */
const findOverlappingBatch = (module.exports.findOverlappingBatch =
  function findOverlappingBatch(batches, candidate, ignoreId) {
    for (const b of batches || []) {
      if (
        ignoreId !== undefined &&
        ignoreId !== null &&
        String(b.id) === String(ignoreId)
      ) {
        continue;
      }
      if (
        Number(b.RangeStart) <= candidate.RangeEnd &&
        Number(b.RangeEnd) >= candidate.RangeStart
      ) {
        return b;
      }
    }
    return null;
  });

/**
 * Turn batch rows (each carrying a `Used` count) into per-broker summaries.
 * Each batch gets Total / Used / Inactive, and every broker gets the sums of
 * all its batches: BlancTotal, BlancUsed and InactivePolicies (the inactive,
 * i.e. still unused, blancs).
 *
 * @param {Array<{id: any, BrokerId: any, RangeStart: any, RangeEnd: any, Used?: any}>} rows
 * @returns {Map<number, {batches: object[], BlancTotal: number, BlancUsed: number, InactivePolicies: number}>}
 */
const summarizeBlancBatches = (module.exports.summarizeBlancBatches =
  function summarizeBlancBatches(rows) {
    const byBroker = new Map();
    for (const r of rows || []) {
      const brokerId = Number(r.BrokerId);
      const start = Number(r.RangeStart);
      const end = Number(r.RangeEnd);
      const total = Math.max(0, end - start + 1);
      const used = Math.min(total, Math.max(0, Number(r.Used) || 0));
      const batch = {
        id: r.id,
        BrokerId: brokerId,
        RangeStart: start,
        RangeEnd: end,
        CreatedBy: r.CreatedBy ?? "",
        CreatedAt: r.CreatedAt ?? null,
        Total: total,
        Used: used,
        Inactive: total - used,
      };
      if (!byBroker.has(brokerId)) {
        byBroker.set(brokerId, {
          batches: [],
          BlancTotal: 0,
          BlancUsed: 0,
          InactivePolicies: 0,
        });
      }
      const s = byBroker.get(brokerId);
      s.batches.push(batch);
      s.BlancTotal += total;
      s.BlancUsed += used;
      s.InactivePolicies += total - used;
    }
    for (const s of byBroker.values()) {
      s.batches.sort((a, b) => a.RangeStart - b.RangeStart);
    }
    return byBroker;
  });

/**
 * Attach the blanc summary to a broker row (a broker without batches gets
 * zeros everywhere). Overwrites the legacy stored InactivePolicies value.
 *
 * @param {object} broker
 * @param {Map<number, object>} summaries  Output of summarizeBlancBatches.
 * @returns {object} The same broker object.
 */
const applyBlancSummary = (module.exports.applyBlancSummary =
  function applyBlancSummary(broker, summaries) {
    const s = summaries.get(Number(broker.id));
    broker.batches = s ? s.batches : [];
    broker.BlancTotal = s ? s.BlancTotal : 0;
    broker.BlancUsed = s ? s.BlancUsed : 0;
    broker.InactivePolicies = s ? s.InactivePolicies : 0;
    return broker;
  });

/**
 * Load blanc batches (of every broker, or of one) together with how many of
 * their blancs are already used. A blanc counts as used when a non-deleted
 * insurance carries it as its (numeric) BlancNumber. Annulled policies still
 * count: an annulled policy keeps its blanc used up, only a deletion gives
 * the blanc back.
 *
 * @param {{query: Function}} db
 * @param {number} [brokerId]
 * @returns {Promise<object[]>}
 */
const loadBlancBatchRows = (module.exports.loadBlancBatchRows =
  async function loadBlancBatchRows(db, brokerId) {
    const hasBroker = brokerId !== undefined && brokerId !== null;
    const [rows] = await db.query(
      `SELECT b.id, b.BrokerId, b.RangeStart, b.RangeEnd, b.CreatedBy, b.CreatedAt,
              (SELECT COUNT(DISTINCT CAST(TRIM(i.BlancNumber) AS UNSIGNED))
                 FROM insurance i
                WHERE TRIM(i.BlancNumber) REGEXP '^[0-9]+$'
                  AND CAST(TRIM(i.BlancNumber) AS UNSIGNED)
                      BETWEEN b.RangeStart AND b.RangeEnd
                  AND i.Deleted = 0) AS Used
         FROM broker_blanc_batches b
        ${hasBroker ? "WHERE b.BrokerId = ?" : ""}
        ORDER BY b.BrokerId, b.RangeStart`,
      hasBroker ? [brokerId] : []
    );
    return rows;
  });
// ---------------------------------------------------------------------------
// Global broker setting: whether broker requests that would push a broker's
// balance negative are accepted. Stored in the `app_settings` key/value table
// (created by db/setup.js). When no row exists the default is to REJECT such
// requests, so the admin toggle is opt-in (negative balances stay disabled
// until an admin enables them).
// ---------------------------------------------------------------------------
const BROKER_ALLOW_NEGATIVE_BALANCE = "broker_allow_negative_balance";

const getBrokerAllowNegativeBalance = (module.exports.getBrokerAllowNegativeBalance =
  async function getBrokerAllowNegativeBalance(conn) {
    try {
      const [rows] = await conn.query(
        "SELECT value FROM app_settings WHERE name = ?",
        [BROKER_ALLOW_NEGATIVE_BALANCE]
      );
      if (!rows.length) return false;
      return String(rows[0].value) !== "0";
    } catch (err) {
      // A missing table or transient failure must never break insurance
      // creation, so fall back to the default (reject negative balances).
      return false;
    }
  });

const setBrokerAllowNegativeBalance = (module.exports.setBrokerAllowNegativeBalance =
  async function setBrokerAllowNegativeBalance(conn, allow) {
    await conn.query(
      `INSERT INTO app_settings (name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [BROKER_ALLOW_NEGATIVE_BALANCE, allow ? "1" : "0"]
    );
  });


/**
 * Create the broker router.

 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createBrokerRouter = function createBrokerRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireBrokerRole = requireRole(1, 2);

  // Read access to broker data. Admins (1) and workers (2) see every broker;
  // a broker-linked client (3) sees only their own broker. Sets req.brokerScope
  // to null (full access) or a broker id.
  const requireBrokerView = (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const role = String(req.user.role);
    if (role === "1" || role === "2") {
      req.brokerScope = null;
      return next();
    }
    if (role === "3") {
      const brokerId = req.user.brokerId ? Number(req.user.brokerId) : null;
      if (!brokerId) {
        return res.status(403).json({
          error: "Forbidden: this account is not linked to a broker",
        });
      }
      req.brokerScope = brokerId;
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  };

  // InactivePolicies / PolicyRange* are no longer selected: inactive blancs
  // are calculated from the blanc batches (see applyBlancSummary).
  const BROKER_COLUMNS = "id, Name, CashBalance";

  // The batches table is created on first use (and by db/setup.js), so the
  // server also works on a database that has not been set up again yet.
  let batchTableReady = null;
  function ensureBatchTable() {
    if (!batchTableReady) {
      batchTableReady = Promise.resolve(
        DBConnection.query(BLANC_BATCH_TABLE_SQL)
      ).catch((err) => {
        batchTableReady = null;
        throw err;
      });
    }
    return batchTableReady;
  }

  let movementTableReady = null;
  function ensureMovementTable() {
    if (!movementTableReady) {
      movementTableReady = Promise.resolve(
        DBConnection.query(BROKER_MOVEMENT_TABLE_SQL)
      ).catch((err) => {
        movementTableReady = null;
        throw err;
      });
    }
    return movementTableReady;
  }

  async function loadSummaries(brokerId) {
    await ensureBatchTable();
    return summarizeBlancBatches(
      await loadBlancBatchRows(DBConnection, brokerId)
    );
  }

  function parseBatchId(param) {
    const id = Number(param);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /**
   * Validate a list of new batches against each other and against every
   * batch already stored (any broker). Returns an error message or null.
   *
   * @param {{query: Function}} conn
   * @param {Array<{RangeStart: number, RangeEnd: number}>} batches
   * @param {number} [ignoreId] Stored batch id to skip (the one being edited).
   */
  async function findBatchConflict(conn, batches, ignoreId) {
    for (let i = 0; i < batches.length; i++) {
      const other = findOverlappingBatch(batches.slice(0, i), batches[i]);
      if (other) {
        return `Batch ${batches[i].RangeStart}-${batches[i].RangeEnd} overlaps batch ${other.RangeStart}-${other.RangeEnd}`;
      }
    }
    for (const b of batches) {
      const [rows] = await conn.query(
        `SELECT bb.id, bb.BrokerId, bb.RangeStart, bb.RangeEnd, br.Name
           FROM broker_blanc_batches bb
           LEFT JOIN brokers br ON br.id = bb.BrokerId
          WHERE bb.RangeStart <= ? AND bb.RangeEnd >= ?`,
        [b.RangeEnd, b.RangeStart]
      );
      const hit = findOverlappingBatch(rows, b, ignoreId);
      if (hit) {
        return `Batch ${b.RangeStart}-${b.RangeEnd} overlaps existing batch ${hit.RangeStart}-${hit.RangeEnd}${hit.Name ? ` (${hit.Name})` : ""}`;
      }
    }
    return null;
  }

  /**
   * Parse `body.batches` (array). Falls back to a single legacy
   * PolicyRangeStart/PolicyRangeEnd pair so older clients keep working.
   * Returns null when the body carries no batch information at all.
   */
  function parseBatchList(body) {
    const b = body || {};
    let list;
    if (Array.isArray(b.batches)) list = b.batches;
    else if (
      [b.PolicyRangeStart, b.policyRangeStart, b.PolicyRangeEnd, b.policyRangeEnd]
        .some((v) => v !== undefined && v !== null && v !== "")
    ) {
      list = [b];
    } else return null;

    const out = [];
    for (const raw of list) {
      const parsed = parseBlancBatch(raw);
      if (!parsed.ok) return { error: parsed.error };
      out.push({ RangeStart: parsed.RangeStart, RangeEnd: parsed.RangeEnd });
    }
    return { batches: out };
  }

  async function insertBatches(conn, brokerId, batches, username) {
    for (const b of batches) {
      await conn.query(
        `INSERT INTO broker_blanc_batches (BrokerId, RangeStart, RangeEnd, CreatedBy)
         VALUES (?, ?, ?, ?)`,
        [brokerId, b.RangeStart, b.RangeEnd, username || ""]
      );
    }
  }

  function parseBrokerId(param) {
    const id = Number(param);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  // Whole positive integer from a query parameter, falling back when absent.
  function parsePositiveIntParam(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  // Keep the history page size inside a sane range.
  function clampPageSize(n) {
    return Math.min(Math.max(n, 1), 100);
  }

  // Parse a "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" query value as a local Date.
  // Returns null when the value is not a valid date.
  function parseHistoryDate(value) {
    const s = String(value).trim();
    if (!s) return null;
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? `${s}T00:00:00`
      : s.replace(" ", "T");
    const d = new Date(norm);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Format a Date as the "YYYY-MM-DD HH:MM:SS" string used by the DATETIME
  // columns, in the server's local time.
  function toLocalDateTime(d) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  }

  // Parse a "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" query value into the
  // CLIENT-local DATETIME literal it denotes. The client sends local calendar
  // days, so no timezone conversion applies here: broker movements are stored
  // in the client's wall clock and must be compared against client-local
  // bounds. Returns null when the value is not a valid date.
  function parseLocalBound(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return parseHistoryDate(s) ? `${s} 00:00:00` : null;
    }
    const norm = s.replace(" ", "T");
    const d = new Date(norm);
    return Number.isNaN(d.getTime()) ? null : s.replace("T", " ");
  }

  function parseBrokerEmails(value) {
    if (value === undefined || value === null) return null;
    const list = Array.isArray(value) ? value : [value];
    const emails = list
      .map((e) => String(e ?? "").trim())
      .filter((e) => e.length > 0);
    return emails;
  }

  async function fetchBroker(res, id) {
    const [[broker]] = await DBConnection.query(
      `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
      [id]
    );
    if (!broker) {
      res.status(404).json({ error: "Broker not found" });
      return null;
    }
    const [emails] = await DBConnection.query(
      "SELECT Email FROM broker_emails WHERE BrokerId = ? ORDER BY id",
      [id]
    );
    const [insurances] = await DBConnection.query(
      "SELECT COUNT(*) AS n FROM insurance WHERE BrokerId = ? AND Deleted = 0",
      [id]
    );
    broker.emails = emails.map((r) => r.Email);
    broker.insuranceCount = insurances[0].n;
    applyBlancSummary(broker, await loadSummaries(id));
    return broker;
  }

  // Build the per-broker bi-weekly rollup: for each two-week period the number
  // of (non-deleted) policies and the net balance movement recorded in the
  // broker balance ledger.
  async function buildBiweeklyResponse(brokerId = null) {
    await ensureMovementTable();
    const schedule = getSchedule(new Date());

    const brokerWhere = brokerId === null ? "" : "WHERE id = ?";
    const brokerParams = brokerId === null ? [] : [brokerId];
    const [brokerRows] = await DBConnection.query(
      `SELECT ${BROKER_COLUMNS} FROM brokers ${brokerWhere} ORDER BY id`,
      brokerParams
    );

    const insWhere =
      brokerId === null
        ? "WHERE BrokerId IS NOT NULL AND Deleted = 0"
        : "WHERE BrokerId = ? AND Deleted = 0";
    const insParams = brokerId === null ? [] : [brokerId];
    const [insuranceRows] = await DBConnection.query(
      `SELECT BrokerId, CreationDate FROM insurance ${insWhere}`,
      insParams
    );

    const movWhere = brokerId === null ? "WHERE Deleted = 0" : "WHERE BrokerId = ? AND Deleted = 0";
    const movParams = brokerId === null ? [] : [brokerId];
    const [movementRows] = await DBConnection.query(
      `SELECT BrokerId, CreatedAt, Amount FROM broker_balance_movements ${movWhere}`,
      movParams
    );

    const summaries = await loadSummaries();
    const brokers = brokerRows.map((b) =>
      applyBlancSummary({ ...b }, summaries)
    );

    const insuranceByBroker = new Map();
    for (const r of insuranceRows) {
      const key = biweekKey(r.CreationDate);
      if (!key) continue;
      if (!insuranceByBroker.has(r.BrokerId)) {
        insuranceByBroker.set(r.BrokerId, new Map());
      }
      const buckets = insuranceByBroker.get(r.BrokerId);
      const entry = buckets.get(key) || { policies: 0 };
      entry.policies += 1;
      buckets.set(key, entry);
    }

    const movementByBroker = new Map();
    for (const r of movementRows) {
      const key = biweekKey(r.CreatedAt);
      if (!key) continue;
      if (!movementByBroker.has(r.BrokerId)) {
        movementByBroker.set(r.BrokerId, new Map());
      }
      const buckets = movementByBroker.get(r.BrokerId);
      buckets.set(key, (buckets.get(key) || 0) + Number(r.Amount || 0));
    }

    for (const b of brokers) {
      const ins = insuranceByBroker.get(b.id) || new Map();
      const mov = movementByBroker.get(b.id) || new Map();
      const keys = new Set([...ins.keys(), ...mov.keys()]);
      const periods = [];
      for (const key of keys) {
        const start = new Date(`${key}T00:00:00Z`);
        const end = new Date(start.getTime() + 13 * DAY_MS);
        const i = ins.get(key) || { policies: 0 };
        const m = mov.get(key) || 0;
        periods.push({
          start: key,
          end: end.toISOString().slice(0, 10),
          policies: i.policies,
          balanceMovement: Math.round(m * 100) / 100,
        });
      }
      periods.sort((a, c) => a.start.localeCompare(c.start));
      b.periods = periods;
    }

    // Payment cut-off status: a broker is cut off when their balance was
    // already negative at the start of the current period and is still
    // negative now (i.e. they missed the last payment and haven't paid).
    const [movSinceRows] = await DBConnection.query(
      `SELECT BrokerId, COALESCE(SUM(Amount), 0) AS since
         FROM broker_balance_movements
        WHERE CreatedAt >= ? AND Deleted = 0
        GROUP BY BrokerId`,
      [`${schedule.periodStart} 00:00:00`]
    );
    const sinceByBroker = new Map(
      movSinceRows.map((r) => [r.BrokerId, Number(r.since)])
    );
    for (const b of brokers) {
      const balance = Number(b.CashBalance) || 0;
      const since = sinceByBroker.get(b.id) || 0;
      b.cutOff = balance < 0 && balance - since < 0;
    }

    return { periodLengthDays: 14, schedule, brokers };
  }

  // GET /brokers — list every broker with its balance, blanc batches,
  // calculated inactive blancs and emails.
  router.get("/brokers", auth, requireBrokerView, async (req, res) => {
    try {
      const scoped = req.brokerScope;
      const [rows] = await DBConnection.query(
        scoped === null
          ? `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
          : `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
        scoped === null ? [] : [scoped]
      );
      const summaries = await loadSummaries();
      for (const b of rows) applyBlancSummary(b, summaries);
      const [emailRows] = await DBConnection.query(
        scoped === null
          ? "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
          : "SELECT BrokerId, Email FROM broker_emails WHERE BrokerId = ?",
        scoped === null ? [] : [scoped]
      );
      const emailsByBroker = new Map();
      for (const e of emailRows) {
        if (!emailsByBroker.has(e.BrokerId)) emailsByBroker.set(e.BrokerId, []);
        emailsByBroker.get(e.BrokerId).push(e.Email);
      }
      for (const b of rows) b.emails = emailsByBroker.get(b.id) || [];
      const allowNegativeBalance = await getBrokerAllowNegativeBalance(
        DBConnection
      );
      res.json({ brokers: rows, allowNegativeBalance });
    } catch (err) {
      console.error("Broker list failed:", err);
      res.status(500).json({ error: "Failed to fetch brokers" });
    }
  });

  // GET /brokers/biweekly — per-broker bi-weekly rollup (policies, revenue and
  // balance movement) for admins (1), workers (2), and broker-linked clients
  // (3, scoped to their own broker). The website's broker dashboard is built
  // from this endpoint.
  router.get("/brokers/biweekly", auth, requireBrokerView, async (req, res) => {
    try {
      res.json(await buildBiweeklyResponse(req.brokerScope));
    } catch (err) {
      console.error("Broker biweekly failed:", err);
      res.status(500).json({ error: "Failed to fetch broker biweekly data" });
    }
  });

  // GET /brokers/export?format=json|csv — extract all broker data.
  router.get("/brokers/export", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
      );
      const [emailRows] = await DBConnection.query(
        "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
      );
      const [insuranceRows] = await DBConnection.query(
        "SELECT BrokerId, COUNT(*) AS n FROM insurance WHERE Deleted = 0 GROUP BY BrokerId"
      );

      const emailsByBroker = new Map();
      for (const e of emailRows) {
        if (!emailsByBroker.has(e.BrokerId)) emailsByBroker.set(e.BrokerId, []);
        emailsByBroker.get(e.BrokerId).push(e.Email);
      }
      const countByBroker = new Map(
        insuranceRows.map((r) => [r.BrokerId, r.n])
      );
      const summaries = await loadSummaries();

      const brokers = rows.map((b) =>
        applyBlancSummary(
          {
            ...b,
            emails: emailsByBroker.get(b.id) || [],
            insuranceCount: countByBroker.get(b.id) || 0,
          },
          summaries
        )
      );

      const format = String(req.query.format || "json").toLowerCase();
      if (format === "csv") {
        const header = [
          "id",
          "Name",
          "CashBalance",
          "BlancBatches",
          "BlancTotal",
          "BlancUsed",
          "InactivePolicies",
          "emails",
          "insuranceCount",
        ];
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [header.join(",")];
        for (const b of brokers) {
          lines.push(
            [
              b.id,
              esc(b.Name),
              b.CashBalance,
              esc(
                b.batches
                  .map((x) => `${x.RangeStart}-${x.RangeEnd}`)
                  .join(";")
              ),
              b.BlancTotal,
              b.BlancUsed,
              b.InactivePolicies,
              esc(b.emails.join(";")),
              b.insuranceCount,
            ].join(",")
          );
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="brokers.csv"'
        );
        return res.send(lines.join("\n"));
      }

      res.json({ brokers });
    } catch (err) {
      console.error("Broker export failed:", err);
      res.status(500).json({ error: "Failed to export brokers" });
    }
  });

  // GET /brokers/settings — read the global broker acceptance setting
  // (admin only).
  router.get("/brokers/settings", auth, requireRole(1), async (req, res) => {
    try {
      const allowNegativeBalance = await getBrokerAllowNegativeBalance(
        DBConnection
      );
      res.json({ allowNegativeBalance });
    } catch (err) {
      console.error("Broker settings read failed:", err);
      res.status(500).json({ error: "Failed to fetch broker settings" });
    }
  });

  // PUT /brokers/settings — update the global broker acceptance setting.
  // { allowNegativeBalance: boolean }. When false, broker requests that would
  // drive the broker balance below zero are rejected.
  router.put("/brokers/settings", auth, requireRole(1), async (req, res) => {
    try {
      const raw = req.body?.allowNegativeBalance;
      const allowNegativeBalance =
        typeof raw === "string" ? raw !== "0" && raw !== "false" : Boolean(raw);
      await setBrokerAllowNegativeBalance(DBConnection, allowNegativeBalance);
      res.json({ allowNegativeBalance });
    } catch (err) {
      console.error("Broker settings update failed:", err);
      res.status(500).json({ error: "Failed to update broker settings" });
    }
  });

  // GET /brokers/:id — single broker.
  router.get("/brokers/:id", auth, requireBrokerView, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      if (req.brokerScope !== null && req.brokerScope !== brokerId) {
        return res
          .status(403)
          .json({ error: "Forbidden: you can only view your own broker" });
      }
      const broker = await fetchBroker(res, brokerId);
      if (!broker) return;
      res.json({ broker });
    } catch (err) {
      console.error("Broker lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch broker" });
    }
  });

  // GET /brokers/:id/biweekly — the bi-weekly rollup of a single broker.
  router.get(
    "/brokers/:id/biweekly",
    auth,
    requireBrokerView,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        if (req.brokerScope !== null && req.brokerScope !== brokerId) {
          return res
            .status(403)
            .json({ error: "Forbidden: you can only view your own broker" });
        }
        const data = await buildBiweeklyResponse(brokerId);
        const broker = data.brokers.find((b) => b.id === brokerId);
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }
        res.json({ broker });
      } catch (err) {
        console.error("Broker biweekly lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch broker biweekly data" });
      }
    }
  );

  // GET /brokers/:id/policies — the policies created since the last payment
  // period (i.e. since the start of the current bi-weekly period).
  router.get(
    "/brokers/:id/policies",
    auth,
    requireBrokerView,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        if (req.brokerScope !== null && req.brokerScope !== brokerId) {
          return res
            .status(403)
            .json({ error: "Forbidden: you can only view your own broker" });
        }
        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const schedule = getSchedule(new Date());
        const [policies] = await DBConnection.query(
          `SELECT PolicyNumber, BlancNumber, CarNumber, Price, CurrencyType,
                  Duration, Branch, PaymentType, CreationDate, StartDate
             FROM insurance
            WHERE BrokerId = ? AND Deleted = 0 AND CreationDate >= ?
            ORDER BY CreationDate DESC`,
          [brokerId, `${schedule.periodStart} 00:00:00`]
        );

        res.json({
          broker: {
            id: broker.id,
            Name: broker.Name,
            CashBalance: broker.CashBalance,
          },
          schedule,
          policies,
        });
      } catch (err) {
        console.error("Broker policies lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch broker policies" });
      }
    }
  );

  // GET /brokers/:id/history — the broker's balance movements for the last
  // month (default), newest first, paginated (40 per page by default).
  // Optional ?since / ?until (YYYY-MM-DD[ HH:MM:SS]) override the window and
  // ?page / ?pageSize control pagination.
  router.get(
    "/brokers/:id/history",
    auth,
    requireBrokerView,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        if (req.brokerScope !== null && req.brokerScope !== brokerId) {
          return res
            .status(403)
            .json({ error: "Forbidden: you can only view your own broker" });
        }

        await ensureMovementTable();

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const page = parsePositiveIntParam(req.query.page, 1);
        const pageSize = clampPageSize(
          parsePositiveIntParam(req.query.pageSize, 40)
        );

        // Only admins may ask for soft-deleted movements (they are the only ones
        // who can delete/restore them); everyone else always sees live rows.
        const includeRaw = String(req.query.includeDeleted || "").toLowerCase();
        const includeDeleted =
          String(req.user?.role) === "1" &&
          ["1", "true", "yes"].includes(includeRaw);

        const now = new Date();
        // The broker's movements are stamped in the client's local wall clock, so
        // the default window ("last 30 days") must be resolved with the client's
        // UTC offset; otherwise a movement made in the last couple of hours would
        // fall outside the window's upper bound. Explicit since/until are already
        // client-local calendar dates, so they are used as literals.
        const tzOffset = Number(req.query.tzOffset);
        let since;
        let until;
        if (req.query.since === undefined || req.query.since === "") {
          since = clientLocalDateTime(tzOffset, new Date(now.getTime() - 30 * DAY_MS));
        } else {
          since = parseLocalBound(String(req.query.since));
          if (since === null) {
            return res.status(400).json({ error: "Invalid date range" });
          }
        }
        if (req.query.until === undefined || req.query.until === "") {
          until = clientLocalDateTime(tzOffset, now);
        } else {
          until = parseLocalBound(String(req.query.until));
          if (until === null) {
            return res.status(400).json({ error: "Invalid date range" });
          }
        }

        const [[stats]] = await DBConnection.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(Amount), 0) AS net
             FROM broker_balance_movements
            WHERE BrokerId = ? AND CreatedAt >= ? AND CreatedAt < ?
              AND Deleted = 0`,
          [brokerId, since, until]
        );

        const total = Number(stats.total) || 0;
        const netChange =
          Math.round((Number(stats.net) || 0) * 100) / 100;
        const currentBalance =
          Math.round((Number(broker.CashBalance) || 0) * 100) / 100;
        const balanceAtStart =
          Math.round((currentBalance - netChange) * 100) / 100;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const offset = (page - 1) * pageSize;

        const [movementRows] = await DBConnection.query(
          `SELECT t.id, t.Type, t.Amount, t.Reason, t.Author,
                  t.BlancNumber, t.CreatedAt, t.BalanceAfter
             FROM (
               SELECT m.id, m.Amount, m.Type, m.Reason, m.Author,
                      m.BlancNumber, m.CreatedAt,
                      (? - COALESCE(SUM(m.Amount) OVER (
                         ORDER BY m.CreatedAt DESC, m.id DESC
                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ), 0)) AS BalanceAfter
                 FROM broker_balance_movements m
                WHERE m.BrokerId = ?
                  AND m.CreatedAt >= ?
                  AND m.CreatedAt < ?
                  AND m.Deleted = 0
             ) t
            ORDER BY t.CreatedAt DESC, t.id DESC
            LIMIT ? OFFSET ?`,
          [currentBalance, brokerId, since, until, pageSize, offset]
        );

        const movements = movementRows.map((r) => ({
          id: r.id,
          Type: r.Type,
          Amount: Math.round((Number(r.Amount) || 0) * 100) / 100,
          Reason: r.Reason,
          Author: r.Author,
          BlancNumber: r.BlancNumber,
          CreatedAt:
            r.CreatedAt instanceof Date ? toLocalDateTime(r.CreatedAt) : r.CreatedAt,
          BalanceAfter: Math.round((Number(r.BalanceAfter) || 0) * 100) / 100,
        }));

        // Soft-deleted movements are excluded from the live running balance but
        // kept in the database, so an admin can still list and restore them.
        let deleted = [];
        if (includeDeleted) {
          const [deletedRows] = await DBConnection.query(
            `SELECT id, Type, Amount, Reason, Author, BlancNumber, CreatedAt,
                    DeletedAt, DeletedBy
               FROM broker_balance_movements
              WHERE BrokerId = ? AND Deleted = 1
              ORDER BY CreatedAt DESC, id DESC
              LIMIT 200`,
            [brokerId]
          );
          deleted = deletedRows.map((r) => ({
            id: r.id,
            Type: r.Type,
            Amount: Math.round((Number(r.Amount) || 0) * 100) / 100,
            Reason: r.Reason,
            Author: r.Author,
            BlancNumber: r.BlancNumber,
            CreatedAt:
              r.CreatedAt instanceof Date ? toLocalDateTime(r.CreatedAt) : r.CreatedAt,
            DeletedAt:
              r.DeletedAt instanceof Date ? toLocalDateTime(r.DeletedAt) : r.DeletedAt,
            DeletedBy: r.DeletedBy,
          }));
        }

        res.json({
          broker: {
            id: broker.id,
            Name: broker.Name,
            CashBalance: currentBalance,
          },
          since,
          until,
          page,
          pageSize,
          total,
          totalPages,
          balanceAtStart,
          netChange,
          movements,
          includeDeleted,
          deleted,
        });
      } catch (err) {
        console.error("Broker history lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch broker history" });
      }
    }
  );

  // PATCH /brokers/:id/history/:movementId — admin-only correction of a single
  // balance movement. `amount` is the only field that changes the balance: the
  // stored CashBalance is shifted by (new - old) so the ledger and the balance
  // stay consistent. `type`, `reason`, `author` and `blancNumber` are cosmetic
  // and are stored verbatim.
  router.patch(
    "/brokers/:id/history/:movementId",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const movementId = parseBrokerId(req.params.movementId);
        if (movementId === null) {
          return res.status(400).json({ error: "Invalid movement id" });
        }

        await ensureMovementTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, BrokerId, Amount, Type, Reason, Author, BlancNumber
             FROM broker_balance_movements
            WHERE id = ? AND BrokerId = ? AND Deleted = 0`,
          [movementId, brokerId]
        );
        if (!existing) {
          return res.status(404).json({ error: "Movement not found" });
        }

        const b = req.body || {};
        const sets = [];
        const params = [];
        let newAmount = null;

        // Accept both camelCase and PascalCase keys, mirroring the way the
        // broker PATCH endpoint handles field naming.
        const pick = (...keys) => {
          for (const k of keys) {
            if (b[k] !== undefined && b[k] !== null) return b[k];
          }
          return undefined;
        };

        const rawAmount = pick("amount", "Amount");
        if (rawAmount !== undefined && rawAmount !== "") {
          const amount = toDecimal(rawAmount);
          if (amount === null || amount === 0) {
            return res
              .status(400)
              .json({ error: "amount must be a non-zero number" });
          }
          newAmount = Math.round(amount * 100) / 100;
          sets.push("Amount = ?");
          params.push(newAmount);
        }

        const rawType = pick("type", "Type");
        if (rawType !== undefined && rawType !== "") {
          const type = String(rawType).trim();
          if (!type) {
            return res.status(400).json({ error: "Type cannot be empty" });
          }
          sets.push("Type = ?");
          params.push(type);
        }

        const rawReason = pick("reason", "Reason");
        if (rawReason !== undefined) {
          sets.push("Reason = ?");
          params.push(String(rawReason));
        }

        const rawAuthor = pick("author", "Author");
        if (rawAuthor !== undefined) {
          sets.push("Author = ?");
          params.push(String(rawAuthor));
        }

        const rawBlanc = pick("blancNumber", "BlancNumber");
        if (rawBlanc !== undefined) {
          const blanc = String(rawBlanc).trim();
          sets.push("BlancNumber = ?");
          params.push(blanc ? blanc : null);
        }

        if (sets.length === 0) {
          return res.status(400).json({ error: "Nothing to update" });
        }

        const previousAmount = Number(existing.Amount) || 0;
        const delta =
          Math.round(((newAmount ?? previousAmount) - previousAmount) * 100) /
          100;

        await DBConnection.withTransaction(async (conn) => {
          params.push(movementId);
          await conn.query(
            `UPDATE broker_balance_movements SET ${sets.join(", ")} WHERE id = ?`,
            params
          );
          if (delta !== 0) {
            await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [delta, brokerId]
            );
          }
        });

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({ message: "Movement updated", broker });
      } catch (err) {
        console.error("Broker movement update failed:", err);
        res.status(500).json({ error: "Failed to update broker movement" });
      }
    }
  );

  // DELETE /brokers/:id/history/:movementId — admin-only removal of a single
  // movement. The row is NEVER physically deleted: it is tied off as
  // (Deleted = 1, DeletedAt, DeletedBy) so it stays recoverable, and its
  // effect on the broker's CashBalance is reversed. POST …/restore undoes it.
  router.delete(
    "/brokers/:id/history/:movementId",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const movementId = parseBrokerId(req.params.movementId);
        if (movementId === null) {
          return res.status(400).json({ error: "Invalid movement id" });
        }

        await ensureMovementTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, Amount, Deleted FROM broker_balance_movements
            WHERE id = ? AND BrokerId = ?`,
          [movementId, brokerId]
        );
        if (!existing) {
          return res.status(404).json({ error: "Movement not found" });
        }
        if (existing.Deleted) {
          return res.status(400).json({ error: "Movement already deleted" });
        }

        const reversal = Math.round(Number(existing.Amount) * -100) / 100;

        await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            `UPDATE broker_balance_movements
                SET Deleted = ?, DeletedAt = ?, DeletedBy = ?
              WHERE id = ?`,
            [1, new Date(), req.user.username, movementId]
          );
          await conn.query(
            "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
            [reversal, brokerId]
          );
        });

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({ message: "Movement deleted", broker });
      } catch (err) {
        console.error("Broker movement delete failed:", err);
        res.status(500).json({ error: "Failed to delete broker movement" });
      }
    }
  );

  // POST /brokers/:id/history/:movementId/restore — admin-only undo of a soft
  // delete. Re-applies the movement's amount to the broker's CashBalance and
  // clears Deleted/DeletedAt/DeletedBy, putting the row back as it was.
  router.post(
    "/brokers/:id/history/:movementId/restore",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const movementId = parseBrokerId(req.params.movementId);
        if (movementId === null) {
          return res.status(400).json({ error: "Invalid movement id" });
        }

        await ensureMovementTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, Amount, Deleted FROM broker_balance_movements
            WHERE id = ? AND BrokerId = ?`,
          [movementId, brokerId]
        );
        if (!existing) {
          return res.status(404).json({ error: "Movement not found" });
        }
        if (!existing.Deleted) {
          return res.status(400).json({ error: "Movement is not deleted" });
        }

        const reapply = Math.round((Number(existing.Amount) || 0) * 100) / 100;

        await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            `UPDATE broker_balance_movements
                SET Deleted = ?, DeletedAt = ?, DeletedBy = ?
              WHERE id = ?`,
            [0, null, null, movementId]
          );
          await conn.query(
            "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
            [reapply, brokerId]
          );
        });

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({ message: "Movement restored", broker });
      } catch (err) {
        console.error("Broker movement restore failed:", err);
        res.status(500).json({ error: "Failed to restore broker movement" });
      }
    }
  );

  // POST /brokers/:id/increase  { amount, reason, currency }
  router.post(
    "/brokers/:id/increase",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const amount = parsePositiveAmount(req.body?.amount);
        if (amount === null) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }
        const reason = (
          typeof req.body?.reason === "string" ? req.body.reason : ""
        ).trim();
        if (!reason) {
          return res.status(400).json({ error: "reason is required" });
        }
        const currency = normalizeCurrency(req.body?.currency);
        const branch = normalizeBranch(req.body?.branch);

        const moveTime = resolveBrokerCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }

        // Update the broker balance and mirror the movement into current cash in
        // one transaction, so the two ledgers can never diverge.
        const affectedRows = await DBConnection.withTransaction(
          async (conn) => {
            const [r] = await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [amount, brokerId]
            );
            if (r.affectedRows === 0) return r.affectedRows;

            await recordCashMovement(
              conn,
              branch,
              req.user.username,
              "increase",
              amount,
              reason,
              currency,
              moveTime.createdAt
            );

            await recordBrokerMovement(conn, brokerId, amount, "increase", {
              reason,
              author: req.user.username,
              createdAt: moveTime.createdAt,
            });

            return r.affectedRows;
          }
        );

        if (affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({
          message: "Broker balance increased",
          amount,
          currency,
          broker,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Broker increase failed:", err);
        res.status(500).json({ error: "Failed to increase broker balance" });
      }
    }
  );

  // POST /brokers/:id/reduce  { amount, reason, currency } — balance may go
  // infinitely negative. Unlike the increase endpoint, this does NOT touch
  // current cash: current cash only ever increases when a broker balance is
  // increased (money actually coming in), so reducing a broker balance must
  // never decrease current cash or be blocked by its availability.
  router.post(
    "/brokers/:id/reduce",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }
        const amount = parsePositiveAmount(req.body?.amount);
        if (amount === null) {
          return res
            .status(400)
            .json({ error: "amount must be a positive number" });
        }
        const reason = (
          typeof req.body?.reason === "string" ? req.body.reason : ""
        ).trim();
        if (!reason) {
          return res.status(400).json({ error: "reason is required" });
        }
        const currency = normalizeCurrency(req.body?.currency);

        const moveTime = resolveBrokerCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }

        const [r] = await DBConnection.query(
          "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
          [amount, brokerId]
        );

        if (r.affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        await recordBrokerMovement(DBConnection, brokerId, -amount, "reduce", {
          reason,
          author: req.user.username,
          createdAt: moveTime.createdAt,
        });

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        res.json({
          message: "Broker balance reduced",
          amount,
          currency,
          broker,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Broker reduce failed:", err);
        res.status(500).json({ error: "Failed to reduce broker balance" });
      }
    }
  );

  // ---------------------------------------------------------------------
  // Admin-only broker data manipulation + extraction (role 1)
  // ---------------------------------------------------------------------
  //
  // Manipulation: create, update (fields + emails), and delete brokers.
  // Extraction: export the full broker dataset (including emails and linked
  // insurance counts) as JSON or flattened CSV.

  const requireAdmin = requireRole(1);

  // POST /brokers — create a broker (with optional emails).
  router.post("/brokers", auth, requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.Name ?? req.body?.name ?? "").trim();
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const toNumber = (v) => {
        if (v === undefined || v === null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const cashBalance =
        toNumber(req.body?.CashBalance ?? req.body?.cashBalance) ?? 0;

      // Blanc batches are optional on creation: more can be added any time
      // through POST /brokers/:id/batches.
      const batchList = parseBatchList(req.body);
      if (batchList && batchList.error) {
        return res.status(400).json({ error: batchList.error });
      }
      const batches = batchList ? batchList.batches : [];

      const emails = parseBrokerEmails(req.body?.emails) || [];

      await ensureBatchTable();

      let brokerId;
      let conflict = null;
      try {
        brokerId = await DBConnection.withTransaction(async (conn) => {
          conflict = await findBatchConflict(conn, batches);
          if (conflict) return null;

          // The legacy range / counter columns are kept at 0: inactive blancs
          // are calculated from broker_blanc_batches.
          const [result] = await conn.query(
            `INSERT INTO brokers
               (Name, CashBalance, PolicyRangeStart, PolicyRangeEnd, InactivePolicies)
             VALUES (?, ?, ?, ?, ?)`,
            [name, cashBalance, 0, 0, 0]
          );
          const id = result.insertId;
          await insertBatches(conn, id, batches, req.user?.username);
          for (const email of emails) {
            await conn.query(
              "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
              [id, email]
            );
          }
          return id;
        });
      } catch (err) {
        if (err?.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A broker with this Name already exists" });
        }
        throw err;
      }
      if (conflict) {
        return res.status(409).json({ error: conflict });
      }

      const broker = await fetchBroker(res, brokerId);
      res.status(201).json({ message: "Broker created", broker });
    } catch (err) {
      console.error("Broker create failed:", err);
      res.status(500).json({ error: "Failed to create broker" });
    }
  });

  // PATCH /brokers/:id — update broker fields and/or emails.
  router.patch("/brokers/:id", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }

      const [existing] = await DBConnection.query(
        "SELECT id, CashBalance FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }
      const previousCashBalance = Number(existing[0].CashBalance);

      const b = req.body || {};
      const sets = [];
      const params = [];
      let newCashBalance = null;

      // Blanc ranges are no longer broker fields - they are managed as
      // batches (POST/PATCH/DELETE /brokers/:id/batches), and InactivePolicies
      // is calculated from them, so neither can be set here.
      const fieldMap = [
        ["Name", b.Name ?? b.name],
        ["CashBalance", b.CashBalance ?? b.cashBalance],
      ];

      for (const [column, value] of fieldMap) {
        if (value !== undefined && value !== null) {
          const v = column === "Name" ? String(value).trim() : Number(value);
          if (column === "Name" && !v) {
            return res.status(400).json({ error: "Name cannot be empty" });
          }
          if (column !== "Name" && !Number.isFinite(v)) {
            return res
              .status(400)
              .json({ error: `${column} must be a number` });
          }
          sets.push(`${column} = ?`);
          params.push(v);
          if (column === "CashBalance") newCashBalance = v;
        }
      }

      const emails = parseBrokerEmails(b.emails);

      if (sets.length === 0 && emails === null) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      try {
        const moveTime = resolveBrokerCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }
        await DBConnection.withTransaction(async (conn) => {
          if (sets.length > 0) {
            params.push(brokerId);
            await conn.query(
              `UPDATE brokers SET ${sets.join(", ")} WHERE id = ?`,
              params
            );
          }
          if (newCashBalance !== null) {
            const delta =
              Math.round((newCashBalance - previousCashBalance) * 100) / 100;
            if (delta !== 0) {
              await recordBrokerMovement(conn, brokerId, delta, "adjust", {
                reason: "Balance adjusted",
                author: req.user.username,
                createdAt: moveTime.createdAt,
              });
            }
          }
          if (emails !== null) {
            await conn.query("DELETE FROM broker_emails WHERE BrokerId = ?", [
              brokerId,
            ]);
            for (const email of emails) {
              await conn.query(
                "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
                [brokerId, email]
              );
            }
          }
        });
      } catch (err) {
        if (err?.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "A broker with this Name already exists" });
        }
        throw err;
      }

      const broker = await fetchBroker(res, brokerId);
      res.json({ message: "Broker updated", broker });
    } catch (err) {
      console.error("Broker update failed:", err);
      res.status(500).json({ error: "Failed to update broker" });
    }
  });

  // DELETE /brokers/:id — remove a broker and detach any linked insurances.
  router.delete("/brokers/:id", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }

      const [existing] = await DBConnection.query(
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      await DBConnection.withTransaction(async (conn) => {
        // Detach any linked insurance policies before removing the broker.
        await conn.query(
          "UPDATE insurance SET BrokerId = NULL WHERE BrokerId = ?",
          [brokerId]
        );
        await conn.query("DELETE FROM broker_emails WHERE BrokerId = ?", [
          brokerId,
        ]);
        await conn.query(
          "DELETE FROM broker_blanc_batches WHERE BrokerId = ?",
          [brokerId]
        );
        await conn.query("DELETE FROM brokers WHERE id = ?", [brokerId]);
      });

      res.json({ message: "Broker deleted", id: brokerId });
    } catch (err) {
      console.error("Broker delete failed:", err);
      res.status(500).json({ error: "Failed to delete broker" });
    }
  });

  // ---------------------------------------------------------------------
  // Blanc batches
  // ---------------------------------------------------------------------
  //
  // GET    /brokers/:id/batches              list + calculated totals
  // POST   /brokers/:id/batches              add { RangeStart, RangeEnd }
  //                                          or several { batches: [...] }
  // PATCH  /brokers/:id/batches/:batchId     correct a batch's range
  // DELETE /brokers/:id/batches/:batchId     remove a batch
  //
  // Writes are admin-only, reject any range overlapping a stored batch (of
  // any broker) and answer with the refreshed broker, so the client re-renders
  // with the recalculated InactivePolicies.

  async function requireExistingBroker(req, res) {
    const brokerId = parseBrokerId(req.params.id);
    if (brokerId === null) {
      res.status(400).json({ error: "Invalid broker id" });
      return null;
    }
    const [existing] = await DBConnection.query(
      "SELECT id FROM brokers WHERE id = ?",
      [brokerId]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: "Broker not found" });
      return null;
    }
    await ensureBatchTable();
    return brokerId;
  }

  router.get(
    "/brokers/:id/batches",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = await requireExistingBroker(req, res);
        if (brokerId === null) return;
        const s = applyBlancSummary(
          { id: brokerId },
          await loadSummaries(brokerId)
        );
        res.json({
          batches: s.batches,
          BlancTotal: s.BlancTotal,
          BlancUsed: s.BlancUsed,
          InactivePolicies: s.InactivePolicies,
        });
      } catch (err) {
        console.error("Blanc batch list failed:", err);
        res.status(500).json({ error: "Failed to fetch blanc batches" });
      }
    }
  );

  router.post("/brokers/:id/batches", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = await requireExistingBroker(req, res);
      if (brokerId === null) return;

      const body = req.body || {};
      const parsed = parseBatchList(
        Array.isArray(body.batches) ? body : { batches: [body] }
      );
      if (!parsed || parsed.error) {
        return res
          .status(400)
          .json({ error: (parsed && parsed.error) || "No batch given" });
      }
      if (parsed.batches.length === 0) {
        return res.status(400).json({ error: "No batch given" });
      }

      let conflict = null;
      await DBConnection.withTransaction(async (conn) => {
        conflict = await findBatchConflict(conn, parsed.batches);
        if (conflict) return;
        await insertBatches(conn, brokerId, parsed.batches, req.user?.username);
      });
      if (conflict) return res.status(409).json({ error: conflict });

      const broker = await fetchBroker(res, brokerId);
      if (!broker) return;
      res.status(201).json({ message: "Blanc batch added", broker });
    } catch (err) {
      console.error("Blanc batch create failed:", err);
      res.status(500).json({ error: "Failed to add blanc batch" });
    }
  });

  router.patch(
    "/brokers/:id/batches/:batchId",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = await requireExistingBroker(req, res);
        if (brokerId === null) return;
        const batchId = parseBatchId(req.params.batchId);
        if (batchId === null) {
          return res.status(400).json({ error: "Invalid batch id" });
        }
        const parsed = parseBlancBatch(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        const batch = {
          RangeStart: parsed.RangeStart,
          RangeEnd: parsed.RangeEnd,
        };

        let status = 200;
        let error = null;
        await DBConnection.withTransaction(async (conn) => {
          const [found] = await conn.query(
            "SELECT id FROM broker_blanc_batches WHERE id = ? AND BrokerId = ?",
            [batchId, brokerId]
          );
          if (found.length === 0) {
            status = 404;
            error = "Blanc batch not found";
            return;
          }
          const conflict = await findBatchConflict(conn, [batch], batchId);
          if (conflict) {
            status = 409;
            error = conflict;
            return;
          }
          await conn.query(
            "UPDATE broker_blanc_batches SET RangeStart = ?, RangeEnd = ? WHERE id = ?",
            [batch.RangeStart, batch.RangeEnd, batchId]
          );
        });
        if (error) return res.status(status).json({ error });

        const broker = await fetchBroker(res, brokerId);
        if (!broker) return;
        res.json({ message: "Blanc batch updated", broker });
      } catch (err) {
        console.error("Blanc batch update failed:", err);
        res.status(500).json({ error: "Failed to update blanc batch" });
      }
    }
  );

  router.delete(
    "/brokers/:id/batches/:batchId",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = await requireExistingBroker(req, res);
        if (brokerId === null) return;
        const batchId = parseBatchId(req.params.batchId);
        if (batchId === null) {
          return res.status(400).json({ error: "Invalid batch id" });
        }
        const [r] = await DBConnection.query(
          "DELETE FROM broker_blanc_batches WHERE id = ? AND BrokerId = ?",
          [batchId, brokerId]
        );
        if (!r || r.affectedRows === 0) {
          return res.status(404).json({ error: "Blanc batch not found" });
        }
        const broker = await fetchBroker(res, brokerId);
        if (!broker) return;
        res.json({ message: "Blanc batch deleted", broker });
      } catch (err) {
        console.error("Blanc batch delete failed:", err);
        res.status(500).json({ error: "Failed to delete blanc batch" });
      }
    }
  );

  // ---------------------------------------------------------------
  // Broker Pricing endpoints (admin-only)
  // ---------------------------------------------------------------

  // GET /brokers/:brokerId/pricing — retrieve all pricing for a broker
  router.get(
    "/brokers/:brokerId/pricing",
    auth,
    requireBrokerRole,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.brokerId);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker ID" });
        }

        // Check if broker exists
        const [brokerCheck] = await DBConnection.query(
          "SELECT id, Name FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (brokerCheck.length === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }
        const brokerName = brokerCheck[0].Name;

        const loadPricing = async () => {
          const [rows] = await DBConnection.query(
            `SELECT InsuranceType, Duration, Price
               FROM broker_tariffs
              WHERE BrokerId = ?
              ORDER BY InsuranceType, Duration`,
            [brokerId]
          );
          // Structure: { vehicleType: { duration: price, ... }, ... }
          const result = {};
          for (const row of rows) {
            if (!result[row.InsuranceType]) result[row.InsuranceType] = {};
            result[row.InsuranceType][String(row.Duration)] = parseFloat(
              row.Price
            );
          }
          return result;
        };

        let pricing = await loadPricing();
        let source = "database";

        // Nothing in the database yet: fall back to BrokerInfo.js and seed it.
        if (Object.keys(pricing).length === 0 && Pricing[brokerName]) {
          try {
            await seedBrokerTariffsIfMissing(
              DBConnection,
              brokerId,
              brokerName
            );
            pricing = await loadPricing();
          } catch (seedErr) {
            console.warn("Broker tariff seed failed:", seedErr.message);
          }
          if (Object.keys(pricing).length === 0) {
            // Seeding failed: still show the BrokerInfo.js values.
            for (const [type, durations] of Object.entries(
              Pricing[brokerName]
            )) {
              pricing[type] = {};
              for (const [d, p] of Object.entries(durations)) {
                pricing[type][String(d)] = Number(p);
              }
            }
          }
          source = "BrokerInfo";
        }

        res.json({
          success: true,
          brokerId,
          brokerName,
          source,
          pricing: pricing,
        });
      } catch (err) {
        console.error("Error fetching broker pricing:", err);
        res.status(500).json({
          success: false,
          error: err.message || "Database error",
        });
      }
    }
  );

  // PUT /brokers/:brokerId/pricing — update pricing for a broker
  router.put(
    "/brokers/:brokerId/pricing",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.brokerId);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker ID" });
        }

        const { pricing } = req.body;

        // Validate request data
        if (!pricing || typeof pricing !== "object") {
          return res.status(400).json({
            success: false,
            error: "Invalid pricing data format",
          });
        }

        // Check if broker exists
        const [brokerCheck] = await DBConnection.query(
          "SELECT id FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (brokerCheck.length === 0) {
          return res.status(404).json({
            success: false,
            error: "Broker not found",
          });
        }

        // Update pricing in transaction
        const updatedPricing = await DBConnection.withTransaction(
          async (conn) => {
            // Delete existing pricing for this broker
            await conn.query("DELETE FROM broker_tariffs WHERE BrokerId = ?", [
              brokerId,
            ]);

            // Insert new pricing
            for (const vehicleType in pricing) {
              // Validate vehicle type
              if (typeof vehicleType !== "string" || !vehicleType.trim()) {
                throw new Error(`Invalid vehicle type: ${vehicleType}`);
              }

              const durations = pricing[vehicleType];

              // Validate durations object
              if (!durations || typeof durations !== "object") {
                throw new Error(
                  `Invalid durations for vehicle type: ${vehicleType}`
                );
              }

              for (const durationStr in durations) {
                const duration = parseInt(durationStr);
                const price = parseFloat(durations[durationStr]);

                // Validate duration
                if (isNaN(duration) || duration <= 0) {
                  throw new Error(`Invalid duration: ${durationStr}`);
                }

                // Validate price
                if (isNaN(price) || price < 0) {
                  throw new Error(
                    `Price cannot be negative for ${vehicleType} ${duration} days`
                  );
                }

                // Insert pricing
                await conn.query(
                  `INSERT INTO broker_tariffs (BrokerId, InsuranceType, Duration, Price)
                    VALUES (?, ?, ?, ?)`,
                  [brokerId, vehicleType, duration, price]
                );
              }
            }

            // Fetch updated pricing to return
            const [updatedRows] = await conn.query(
              `SELECT InsuranceType, Duration, Price
                FROM broker_tariffs
                WHERE BrokerId = ?
                ORDER BY InsuranceType, Duration`,
              [brokerId]
            );

            const updatedPricing = {};
            for (const row of updatedRows) {
              const vehicleType = row.InsuranceType;
              const duration = String(row.Duration);
              const price = parseFloat(row.Price);

              if (!updatedPricing[vehicleType]) {
                updatedPricing[vehicleType] = {};
              }
              updatedPricing[vehicleType][duration] = price;
            }

            return updatedPricing;
          }
        );

        res.json({
          success: true,
          message: "Pricing updated successfully",
          pricing: updatedPricing,
        });
      } catch (err) {
        console.error("Error updating broker pricing:", err);
        res.status(500).json({
          success: false,
          error: err.message || "Error updating pricing",
        });
      }
    }
  );

  return router;
};

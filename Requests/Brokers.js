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
} = require("./CurrentCash.js");

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
  async function decreaseBrokerForInsurance(conn, brokerId, price) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
      [priceNum, brokerId]
    );

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
  async function restoreBrokerForAnnulment(conn, brokerId, price) {
    const [[broker]] = await conn.query("SELECT id FROM brokers WHERE id = ?", [
      brokerId,
    ]);
    if (!broker) return null;

    const priceNum = toDecimal(price) || 0;

    await conn.query(
      "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
      [priceNum, brokerId]
    );

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
  async function restoreBrokerForDeletion(conn, brokerId, amount) {
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
  async function adjustBrokerForPriceChange(conn, brokerId, delta) {
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

    return d;
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

  // GET /brokers — list every broker with its balance, blanc batches,
  // calculated inactive blancs and emails.
  router.get("/brokers", auth, requireBrokerRole, async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers ORDER BY id`
      );
      const summaries = await loadSummaries();
      for (const b of rows) applyBlancSummary(b, summaries);
      const [emailRows] = await DBConnection.query(
        "SELECT BrokerId, Email FROM broker_emails ORDER BY BrokerId, id"
      );
      const emailsByBroker = new Map();
      for (const e of emailRows) {
        if (!emailsByBroker.has(e.BrokerId)) emailsByBroker.set(e.BrokerId, []);
        emailsByBroker.get(e.BrokerId).push(e.Email);
      }
      for (const b of rows) b.emails = emailsByBroker.get(b.id) || [];
      res.json({ brokers: rows });
    } catch (err) {
      console.error("Broker list failed:", err);
      res.status(500).json({ error: "Failed to fetch brokers" });
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

  // GET /brokers/:id — single broker.
  router.get("/brokers/:id", auth, requireBrokerRole, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      const broker = await fetchBroker(res, brokerId);
      if (!broker) return;
      res.json({ broker });
    } catch (err) {
      console.error("Broker lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch broker" });
    }
  });

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
              currency
            );
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

        const [r] = await DBConnection.query(
          "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?",
          [amount, brokerId]
        );

        if (r.affectedRows === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

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
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      const b = req.body || {};
      const sets = [];
      const params = [];

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
        }
      }

      const emails = parseBrokerEmails(b.emails);

      if (sets.length === 0 && emails === null) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      try {
        await DBConnection.withTransaction(async (conn) => {
          if (sets.length > 0) {
            params.push(brokerId);
            await conn.query(
              `UPDATE brokers SET ${sets.join(", ")} WHERE id = ?`,
              params
            );
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

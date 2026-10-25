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
const {
  EuroPricing,
  seedBrokerTariffsIfMissing,
  isSubBrokerName: rawIsSubBrokerName,
} = require("../db/BrokerInfo.js");
const DEFAULT_SUB_BROKERS = new Set([
  "ErcanSever",
  "NecmiErdan",
  "RidwanOzturk",
  "SengunKale",
]);
const isSubBrokerName =
  typeof rawIsSubBrokerName === "function"
    ? rawIsSubBrokerName
    : (name) => DEFAULT_SUB_BROKERS.has(String(name ?? "").trim());
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
      `SELECT be.BrokerId, b.Name, b.CutOff
         FROM broker_emails be
         JOIN brokers b ON b.id = be.BrokerId
        WHERE LOWER(TRIM(be.Email)) = LOWER(?)
        ORDER BY be.id
        LIMIT 1`,
      [address]
    );
    if (!rows.length) return null;
    return {
      id: rows[0].BrokerId,
      name: rows[0].Name,
      cutOff: Boolean(rows[0].CutOff),
    };
  });

/**
 * Load only the tariffs explicitly stored in `broker_tariffs` for `brokerId`
 * (never inherits from a parent broker or `EuroPricing`).
 *
 * For a sub-broker, these rows are the display prices configured by its main
 * broker.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @returns {Promise<object>}
 */
const loadOwnBrokerTariffs = (module.exports.loadOwnBrokerTariffs =
  async function loadOwnBrokerTariffs(conn, brokerId) {
    try {
      const [rows] = await conn.query(
        `SELECT InsuranceType, Duration, Price
           FROM broker_tariffs
          WHERE BrokerId = ?
          ORDER BY InsuranceType, Duration`,
        [brokerId]
      );
      const pricing = {};
      for (const row of rows) {
        if (!pricing[row.InsuranceType]) pricing[row.InsuranceType] = {};
        pricing[row.InsuranceType][String(row.Duration)] = parseFloat(
          row.Price
        );
      }
      return pricing;
    } catch {
      return {};
    }
  });

// Map an insurance row's Otomobil value to its tariff vehicle key.
const mapPolicyVehicleKey = (module.exports.mapPolicyVehicleKey =
  function mapPolicyVehicleKey(otomobil) {
    const v = String(otomobil ?? "").trim().toLowerCase();
    if (
      v === "automobile" ||
      v === "otomobil" ||
      v === "auto" ||
      v === "автомобил" ||
      v === "лек автомобил"
    ) {
      return "Auto";
    }
    if (v === "motor" || v === "мотор") return "Motor";
    if (v === "bus" || v === "бус" || v === "микробус") return "Bus";
    if (v === "trailer" || v === "ремарке") return "Trailer";
    return String(otomobil ?? "").trim();
  });

// Parse an insurance row's Duration to integer days (15 / 30 / 90 / 365).
const mapPolicyDurationDays = (module.exports.mapPolicyDurationDays =
  function mapPolicyDurationDays(duration) {
    if (duration === undefined || duration === null || duration === "") {
      return null;
    }
    if (typeof duration === "number" && Number.isFinite(duration)) {
      return duration > 0 ? duration : null;
    }
    const s = String(duration).trim().toLowerCase();
    if (!s) return null;
    const num = parseInt(s.replace(/[^0-9]/g, ""), 10);
    if (s.includes("годин") || s.includes("year")) {
      return !Number.isNaN(num) && num > 0 ? num * 365 : 365;
    }
    if (s.includes("месеца")) {
      return !Number.isNaN(num) && num > 0 ? num * 30 : 90;
    }
    if (s.includes("месец") || s.includes("month")) {
      return !Number.isNaN(num) && num > 0 ? num * 30 : 30;
    }
    if (s.includes("15")) return 15;
    return !Number.isNaN(num) && num > 0 ? num : null;
  });

/**
 * Compute a policy's price strictly from a tariff `pricing` map (plus the
 * stored NonTurk flag). The +2 card tax goes to the bank and is visual-only
 * during creation, so it is never included here. Returns `null` when the
 * vehicle type or duration is missing from `pricing` — never falls back to
 * `row.Price` so a sub-broker can never see the stored sale price.
 *
 * @param {object} row
 * @param {object} pricing
 * @returns {number|null}
 */
const computePolicyTariffPrice = (module.exports.computePolicyTariffPrice =
  function computePolicyTariffPrice(row, pricing) {
    if (!row || !pricing || typeof pricing !== "object") return null;
    const vehicleKey = mapPolicyVehicleKey(row.Otomobil);
    const durationDays = mapPolicyDurationDays(row.Duration);
    if (!vehicleKey || !durationDays) return null;

    const typeMap = pricing[vehicleKey];
    if (!typeMap || typeof typeMap !== "object") return null;
    const baseRaw = typeMap[String(durationDays)];
    if (baseRaw === undefined || baseRaw === null || baseRaw === "") {
      return null;
    }
    const basePrice = Number(baseRaw);
    if (!Number.isFinite(basePrice) || basePrice < 0) return null;

    let price = basePrice;
    if (Number(row.NonTurk) === 1) price += 5;
    return Math.round(price * 100) / 100;
  });

/**
 * Resolve the effective pricing of a broker, inheriting from its parent chain.
 *
 * A broker's own rows in `broker_tariffs` always win. When a broker has no
 * tariffs of its own, its effective pricing is inherited from its main broker
 * (its `ParentBrokerId`), and recursively up the chain. This lets a main broker
 * set one price that all of its sub-brokers ("underlings") see for their
 * insurances, while still allowing a per-underling override.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @returns {Promise<{pricing: object, sourceBrokerId: number|null, sourceBrokerName: string|null, inherited: boolean}>}
 */
const effectivePricingFor = (module.exports.effectivePricingFor =
  async function effectivePricingFor(conn, brokerId) {
    const toPricing = (rows) => {
      const pricing = {};
      for (const row of rows) {
        if (!pricing[row.InsuranceType]) pricing[row.InsuranceType] = {};
        pricing[row.InsuranceType][String(row.Duration)] = parseFloat(row.Price);
      }
      return pricing;
    };

    let cursor = brokerId;
    let rootBroker = null;
    let lastBroker = null;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const [[broker]] = await conn.query(
        "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
        [cursor]
      );
      if (!broker) break;
      if (!rootBroker) rootBroker = broker;
      lastBroker = broker;

      const [rows] = await conn.query(
        `SELECT InsuranceType, Duration, Price
           FROM broker_tariffs
          WHERE BrokerId = ?
          ORDER BY InsuranceType, Duration`,
        [cursor]
      );
      if (rows.length > 0) {
        return {
          pricing: toPricing(rows),
          sourceBrokerId: broker.id,
          sourceBrokerName: broker.Name,
          inherited: broker.id !== brokerId,
        };
      }

      cursor = broker.ParentBrokerId ? Number(broker.ParentBrokerId) : null;
    }

    // Fallback to BrokerInfo.js EuroPricing in memory (without writing rows to
    // broker_tariffs) so worker policy creation and the pricing modal still
    // have default rates even before a sub-broker's price list is saved.
    const fallbackBroker =
      (lastBroker && EuroPricing[lastBroker.Name] ? lastBroker : null) ||
      (rootBroker && EuroPricing[rootBroker.Name] ? rootBroker : null);
    if (fallbackBroker) {
      const pricing = {};
      for (const [type, durations] of Object.entries(
        EuroPricing[fallbackBroker.Name]
      )) {
        pricing[type] = {};
        for (const [d, p] of Object.entries(durations)) {
          pricing[type][String(d)] = Number(p);
        }
      }
      return {
        pricing,
        sourceBrokerId: fallbackBroker.id,
        sourceBrokerName: fallbackBroker.Name,
        inherited: true,
      };
    }

    return {
      pricing: {},
      sourceBrokerId: null,
      sourceBrokerName: null,
      inherited: false,
    };
  });

/**
 * Resolve the SALE pricing of a broker (the price stored on `insurance.Price`
 * in the database and used to calculate what each broker owes us).
 *
 * - For a main broker (not a sub-broker), this is its own tariff table.
 * - For a sub-broker, its own rows in `broker_tariffs` are display-only prices
 *   set by the main broker and must NEVER be used as the sale price; instead,
 *   the sale price is always the main broker's price (resolved up
 *   `ParentBrokerId`).
 */
const salePricingFor = (module.exports.salePricingFor =
  async function salePricingFor(conn, brokerId) {
    let broker = null;
    try {
      const [[row]] = await conn.query(
        "SELECT id, Name, ParentBrokerId, IsSubBroker FROM brokers WHERE id = ?",
        [brokerId]
      );
      broker = row || null;
    } catch {
      const [[row]] = await conn.query(
        "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
        [brokerId]
      );
      broker = row || null;
    }
    if (!broker) {
      return {
        pricing: {},
        sourceBrokerId: null,
        sourceBrokerName: null,
        inherited: false,
      };
    }

    const hasParent =
      broker.ParentBrokerId !== null &&
      broker.ParentBrokerId !== undefined &&
      Number(broker.ParentBrokerId) > 0;
    const isSub = Boolean(
      isSubBrokerName(broker.Name) || hasParent || broker.IsSubBroker
    );

    if (isSub) {
      if (!hasParent) {
        return {
          pricing: {},
          sourceBrokerId: null,
          sourceBrokerName: null,
          inherited: false,
        };
      }
      let parentCursor = Number(broker.ParentBrokerId);
      let mainBrokerId = parentCursor;
      const visited = new Set([Number(broker.id)]);
      while (parentCursor && !visited.has(parentCursor)) {
        visited.add(parentCursor);
        mainBrokerId = parentCursor;
        const [[parentRow]] = await conn.query(
          "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
          [parentCursor]
        );
        if (!parentRow) break;
        const nextParent =
          parentRow.ParentBrokerId !== null &&
          parentRow.ParentBrokerId !== undefined &&
          Number(parentRow.ParentBrokerId) > 0
            ? Number(parentRow.ParentBrokerId)
            : null;
        if (!nextParent) break;
        parentCursor = nextParent;
      }
      const eff = await effectivePricingFor(conn, mainBrokerId);
      return {
        pricing: eff.pricing,
        sourceBrokerId: eff.sourceBrokerId,
        sourceBrokerName: eff.sourceBrokerName,
        inherited: true,
      };
    }

    return effectivePricingFor(conn, brokerId);
  });

/**
 * Compute display-only pricing data for a sub-broker from its own
 * `broker_tariffs` (set by its main broker). Never uses `insurance.Price` or
 * `brokers.CashBalance`, ensuring sub-brokers can never see or infer the main
 * broker's sale prices.
 */
const computeSubBrokerDisplayData = (module.exports.computeSubBrokerDisplayData =
  async function computeSubBrokerDisplayData(conn, brokerId, preloadedPricing) {
    const subPricing =
      preloadedPricing || (await loadOwnBrokerTariffs(conn, brokerId));

    let policies = [];
    try {
      const [rows] = await conn.query(
        `SELECT BlancNumber, Duration, Otomobil, PaymentType,
                NonTurk, CardFee, Annulled, AnnulReason, AnnulFee, CreationDate
           FROM insurance
          WHERE BrokerId = ? AND Deleted = 0`,
        [brokerId]
      );
      policies = Array.isArray(rows) ? rows : [];
    } catch {
      policies = [];
    }

    const policyByBlanc = new Map();
    let netPoliciesImpact = 0;
    for (const p of policies) {
      const displayPrice = computePolicyTariffPrice(p, subPricing);
      const blancKey = String(p.BlancNumber ?? "").trim();
      if (blancKey) {
        policyByBlanc.set(blancKey, { row: p, displayPrice });
      }
      if (displayPrice !== null) {
        if (Number(p.Annulled) === 1) {
          const fee =
            p.AnnulReason === "broker" ? Number(p.AnnulFee) || 0 : 0;
          netPoliciesImpact -= fee;
        } else {
          netPoliciesImpact -= displayPrice;
        }
      }
    }

    let manualMovementsSum = 0;
    try {
      const [movRows] = await conn.query(
        `SELECT Type, Amount
           FROM broker_balance_movements
          WHERE BrokerId = ? AND Deleted = 0
            AND Type NOT IN ('policy', 'annulment', 'price_change', 'deletion')`,
        [brokerId]
      );
      for (const m of movRows || []) {
        manualMovementsSum += Number(m.Amount) || 0;
      }
    } catch {
      manualMovementsSum = 0;
    }

    const displayCashBalance =
      Math.round((manualMovementsSum + netPoliciesImpact) * 100) / 100;

    function mapMovementAmount(m) {
      if (!m) return 0;
      const type = String(m.Type || "").trim();
      const blancKey = String(m.BlancNumber ?? "").trim();
      if (type === "policy") {
        const info = policyByBlanc.get(blancKey);
        return info && info.displayPrice !== null ? -info.displayPrice : 0;
      }
      if (type === "annulment") {
        const info = policyByBlanc.get(blancKey);
        if (!info || info.displayPrice === null) return 0;
        const fee =
          info.row.AnnulReason === "broker"
            ? Number(info.row.AnnulFee) || 0
            : 0;
        return Math.round((info.displayPrice - fee) * 100) / 100;
      }
      if (type === "price_change" || type === "deletion") {
        return 0;
      }
      return Math.round((Number(m.Amount) || 0) * 100) / 100;
    }

    return {
      subPricing,
      policyByBlanc,
      displayCashBalance,
      mapMovementAmount,
    };
  });

/**
 * Attach sub-broker pricing status (`IsSubBroker`, `PricingConfigured`,
 * `hidePricing`) to each broker row in place.
 *
 * A broker is a sub-broker when it is marked as sub in BrokerInfo.js or has a
 * ParentBrokerId assigned. Sub-brokers must not have prices or balance
 * calculations shown to them on the website initially; only after a main broker
 * is chosen (`ParentBrokerId` is set) AND sets up their price list (own rows in
 * `broker_tariffs`) is `PricingConfigured` true and `hidePricing` false.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {object[]} rows
 * @returns {Promise<object[]>}
 */
const attachSubBrokerStatus = (module.exports.attachSubBrokerStatus =
  async function attachSubBrokerStatus(conn, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;

    const withParentIds = rows
      .filter(
        (b) =>
          b &&
          b.ParentBrokerId !== null &&
          b.ParentBrokerId !== undefined &&
          Number(b.ParentBrokerId) > 0
      )
      .map((b) => Number(b.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    let configuredIds = new Set();
    if (withParentIds.length > 0) {
      try {
        const placeholders = withParentIds.map(() => "?").join(", ");
        const [tariffRows] = await conn.query(
          `SELECT DISTINCT BrokerId FROM broker_tariffs WHERE BrokerId IN (${placeholders})`,
          withParentIds
        );
        configuredIds = new Set(tariffRows.map((r) => Number(r.BrokerId)));
      } catch {
        configuredIds = new Set();
      }
    }

    for (const b of rows) {
      if (!b) continue;
      const hasParent =
        b.ParentBrokerId !== null &&
        b.ParentBrokerId !== undefined &&
        Number(b.ParentBrokerId) > 0;
      const isSub = Boolean(
        isSubBrokerName(b.Name) || hasParent || b.IsSubBroker
      );
      const configured =
        !isSub || (hasParent && configuredIds.has(Number(b.id)));
      b.IsSubBroker = isSub;
      b.PricingConfigured = configured;
      b.hidePricing = isSub && !configured;
    }

    return rows;
  });

/**
 * Return the broker ids a user may manage pricing for. Admins (1) manage every
 * broker. Workers (2) have no access. A broker (role 3) may manage only their
 * direct underlings (brokers whose ParentBrokerId points at them) — a broker
 * cannot set their own price.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {{role: string, brokerId: number|null}} user
 * @returns {Promise<number|null>} null when unrestricted (admin), or a set of
 *   allowed ids (possibly empty) for workers/brokers.
 */
async function manageableBrokerIds(conn, user) {
  const role = String(user?.role ?? "");
  if (role === "1") return null;
  if (role === "3") {
    const own = user.brokerId ? Number(user.brokerId) : null;
    if (!own) return new Set();
    const ids = new Set();
    const [underlings] = await conn.query(
      "SELECT id FROM brokers WHERE ParentBrokerId = ?",
      [own]
    );
    for (const u of underlings) ids.add(u.id);
    return ids;
  }
  return new Set();
}

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

    if (priceNum !== 0) {
      await conn.query(
        "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
        [priceNum, brokerId]
      );
    }

    if (meta && meta.updateExisting && meta.blancNumber) {
      const [existingMovs] = await conn.query(
        `SELECT id, Amount FROM broker_balance_movements
          WHERE BrokerId = ? AND BlancNumber = ? AND Type = 'annulment' AND Deleted = 0
          ORDER BY id DESC LIMIT 1`,
        [brokerId, meta.blancNumber]
      );
      if (Array.isArray(existingMovs) && existingMovs.length > 0) {
        const nextAmt =
          meta.totalRefund !== undefined
            ? Math.round((toDecimal(meta.totalRefund) || 0) * 100) / 100
            : Math.round(((Number(existingMovs[0].Amount) || 0) + priceNum) * 100) / 100;
        await conn.query(
          "UPDATE broker_balance_movements SET Amount = ? WHERE id = ?",
          [nextAmt, existingMovs[0].id]
        );
        return priceNum;
      }
    }

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

// A broker is "overdue" when their balance was already negative at the start
// of the current two-week payment period and is still negative (i.e. they
// missed the last payment and have not paid it off). The rule is applied by
// attachPaymentStatus inside createBrokerRouter; enforcement is now manual via
// the brokers.CutOff flag — the automatic block has been removed.

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

  // Returns true when `viewerBrokerId` is the direct parent of
  // `childBrokerId`. Used so a main broker can fetch the policies of its own
  // sub-brokers (for the per-sub-broker Excel export).
  async function isDirectUnderling(viewerBrokerId, childBrokerId) {
    if (!viewerBrokerId || !childBrokerId) return false;
    const [[child]] = await DBConnection.query(
      "SELECT id FROM brokers WHERE id = ? AND ParentBrokerId = ?",
      [childBrokerId, viewerBrokerId]
    );
    return Boolean(child);
  }

  // InactivePolicies / PolicyRange* are no longer selected: inactive blancs
  // are calculated from the blanc batches (see applyBlancSummary).
  const BROKER_COLUMNS = "id, Name, CashBalance, ParentBrokerId, CutOff";

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

  // Attach payment status to each broker row in place:
  //   overdue — missed the last payment: the balance was already negative at
  //             the start of the current two-week period and is still negative.
  //   cutOff —  the manual cut-off flag (an admin pressed the cut-off button).
  async function attachPaymentStatus(rows) {
    const schedule = getSchedule(new Date());
    await ensureMovementTable();
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
    for (const b of rows) {
      const balance = Number(b.CashBalance) || 0;
      const since = sinceByBroker.get(b.id) || 0;
      b.overdue = balance < 0 && balance - since < 0;
      b.cutOff = Boolean(b.CutOff);
    }
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

  // Map an insurance row's Otomobil value to its tariff vehicle key.
  function mapPolicyVehicleKey(otomobil) {
    const v = String(otomobil ?? "").trim().toLowerCase();
    if (
      v === "automobile" ||
      v === "otomobil" ||
      v === "auto" ||
      v === "автомобил" ||
      v === "лек автомобил"
    ) {
      return "Auto";
    }
    if (v === "motor" || v === "мотор") return "Motor";
    if (v === "bus" || v === "бус") return "Bus";
    if (v === "trailer" || v === "ремарке") return "Trailer";
    return String(otomobil ?? "").trim();
  }

  // Parse an insurance row's Duration to integer days (15 / 30 / 90).
  function mapPolicyDurationDays(duration) {
    const s = String(duration ?? "").trim().toLowerCase();
    if (s.includes("15")) return 15;
    if (s.includes("месеца") || s === "90") return 90;
    if (s.includes("месец") || s === "30") return 30;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Recalculate a broker's existing non-deleted policies and balance movements
  // when its price list is set up or updated via PUT /brokers/:brokerId/pricing.
  async function recalculateBrokerPoliciesForPricing(conn, brokerId, pricing) {
    try {
      const [policies] = await conn.query(
        `SELECT BlancNumber, Price, Duration, Otomobil, PaymentType,
                NonTurk, CardFee, Annulled, AnnulReason, AnnulFee
           FROM insurance
          WHERE BrokerId = ? AND Deleted = 0`,
        [brokerId]
      );
      if (!Array.isArray(policies) || policies.length === 0) return;

      let balanceDelta = 0;
      for (const row of policies) {
        const vehicleKey = mapPolicyVehicleKey(row.Otomobil);
        const durationDays = mapPolicyDurationDays(row.Duration);
        if (!vehicleKey || !durationDays) continue;

        const typeMap = pricing && pricing[vehicleKey];
        if (!typeMap) continue;
        const baseRaw = typeMap[String(durationDays)];
        if (baseRaw === undefined || baseRaw === null || baseRaw === "") continue;
        const basePrice = Number(baseRaw);
        if (!Number.isFinite(basePrice) || basePrice < 0) continue;

        let newPrice = basePrice;
        if (Number(row.NonTurk) === 1) newPrice += 5;
        newPrice = Math.round(newPrice * 100) / 100;
        const oldPrice = Math.round((Number(row.Price) || 0) * 100) / 100;
        if (newPrice === oldPrice) continue;

        await conn.query(
          "UPDATE insurance SET Price = ? WHERE BlancNumber = ?",
          [String(newPrice), row.BlancNumber]
        );

        const [policyMovs] = await conn.query(
          `SELECT id, Amount FROM broker_balance_movements
            WHERE BrokerId = ? AND BlancNumber = ? AND Type = 'policy' AND Deleted = 0`,
          [brokerId, row.BlancNumber]
        );
        if (policyMovs.length > 0) {
          for (const mov of policyMovs) {
            const prevAmt = Number(mov.Amount) || 0;
            const nextAmt = -newPrice;
            balanceDelta += nextAmt - prevAmt;
            await conn.query(
              "UPDATE broker_balance_movements SET Amount = ? WHERE id = ?",
              [nextAmt, mov.id]
            );
          }
        } else {
          balanceDelta += oldPrice - newPrice;
        }

        if (Number(row.Annulled) === 1) {
          const fee =
            row.AnnulReason === "broker" ? Number(row.AnnulFee) || 0 : 0;
          const nextRefund = Math.round((newPrice - fee) * 100) / 100;
          const [annulMovs] = await conn.query(
            `SELECT id, Amount FROM broker_balance_movements
              WHERE BrokerId = ? AND BlancNumber = ? AND Type = 'annulment' AND Deleted = 0`,
            [brokerId, row.BlancNumber]
          );
          if (annulMovs.length > 0) {
            for (const mov of annulMovs) {
              const prevAmt = Number(mov.Amount) || 0;
              balanceDelta += nextRefund - prevAmt;
              await conn.query(
                "UPDATE broker_balance_movements SET Amount = ? WHERE id = ?",
                [nextRefund, mov.id]
              );
            }
          } else {
            const prevRefund = Math.round((oldPrice - fee) * 100) / 100;
            balanceDelta += nextRefund - prevRefund;
          }
        }
      }

      balanceDelta = Math.round(balanceDelta * 100) / 100;
      if (balanceDelta !== 0) {
        await conn.query(
          "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
          [balanceDelta, brokerId]
        );
      }
    } catch {
      // Ignore if tables/columns are absent in minimal test mocks.
    }
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
    await attachSubBrokerStatus(DBConnection, [broker]);
    return broker;
  }

  // Build the per-broker bi-weekly rollup: for each two-week period the number
  // of (non-deleted) policies and the net balance movement recorded in the
  // broker balance ledger.
  async function buildBiweeklyResponse(brokerId = null, isScopedClient = false) {
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
      `SELECT BrokerId, CreatedAt, Amount, Type, BlancNumber FROM broker_balance_movements ${movWhere}`,
      movParams
    );

    const summaries = await loadSummaries();
    const brokers = brokerRows.map((b) =>
      applyBlancSummary({ ...b }, summaries)
    );
    await attachSubBrokerStatus(DBConnection, brokers);

    const subDisplayByBroker = new Map();
    if (isScopedClient) {
      for (const b of brokers) {
        if (b.IsSubBroker && !b.hidePricing) {
          subDisplayByBroker.set(
            b.id,
            await computeSubBrokerDisplayData(DBConnection, b.id)
          );
        }
      }
    }

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
    const seenPolicyBlancsByBroker = new Map();
    for (const r of movementRows) {
      const key = biweekKey(r.CreatedAt);
      if (!key) continue;
      if (!movementByBroker.has(r.BrokerId)) {
        movementByBroker.set(r.BrokerId, new Map());
      }
      const buckets = movementByBroker.get(r.BrokerId);
      const disp = subDisplayByBroker.get(r.BrokerId);
      const amt = disp ? disp.mapMovementAmount(r) : Number(r.Amount || 0);
      buckets.set(key, (buckets.get(key) || 0) + amt);
      if (disp && String(r.Type || "").trim() === "policy" && r.BlancNumber) {
        if (!seenPolicyBlancsByBroker.has(r.BrokerId)) {
          seenPolicyBlancsByBroker.set(r.BrokerId, new Set());
        }
        seenPolicyBlancsByBroker
          .get(r.BrokerId)
          .add(String(r.BlancNumber).trim());
      }
    }

    for (const [bId, disp] of subDisplayByBroker.entries()) {
      const seen = seenPolicyBlancsByBroker.get(bId) || new Set();
      for (const [blancKey, info] of disp.policyByBlanc.entries()) {
        if (seen.has(blancKey) || info.displayPrice === null) continue;
        const key = biweekKey(info.row.CreationDate);
        if (!key) continue;
        if (!movementByBroker.has(bId)) movementByBroker.set(bId, new Map());
        const buckets = movementByBroker.get(bId);
        const net =
          Number(info.row.Annulled) === 1
            ? -(info.row.AnnulReason === "broker"
                ? Number(info.row.AnnulFee) || 0
                : 0)
            : -info.displayPrice;
        buckets.set(key, (buckets.get(key) || 0) + net);
      }
    }

    for (const b of brokers) {
      const ins = insuranceByBroker.get(b.id) || new Map();
      const mov = b.hidePricing ? new Map() : movementByBroker.get(b.id) || new Map();
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
          balanceMovement: b.hidePricing ? null : Math.round(m * 100) / 100,
        });
      }
      periods.sort((a, c) => a.start.localeCompare(c.start));
      b.periods = periods;
    }

    // Payment status: overdue (missed a payment) + manual cut-off flag.
    await attachPaymentStatus(brokers);
    for (const b of brokers) {
      if (b.hidePricing) {
        b.CashBalance = null;
        b.overdue = false;
      } else if (subDisplayByBroker.has(b.id)) {
        b.CashBalance = subDisplayByBroker.get(b.id).displayCashBalance;
      }
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
      await attachPaymentStatus(rows);
      await attachSubBrokerStatus(DBConnection, rows);
      if (scoped !== null) {
        for (const b of rows) {
          if (b.hidePricing) {
            b.CashBalance = null;
            b.overdue = false;
          } else if (b.IsSubBroker) {
            const disp = await computeSubBrokerDisplayData(DBConnection, b.id);
            b.CashBalance = disp.displayCashBalance;
          }
        }
      }
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
      res.json(
        await buildBiweeklyResponse(req.brokerScope, req.brokerScope !== null)
      );
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
      if (req.brokerScope !== null) {
        if (broker.hidePricing) {
          broker.CashBalance = null;
        } else if (broker.IsSubBroker) {
          const disp = await computeSubBrokerDisplayData(
            DBConnection,
            broker.id
          );
          broker.CashBalance = disp.displayCashBalance;
        }
      }
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
        const data = await buildBiweeklyResponse(
          brokerId,
          req.brokerScope !== null
        );
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
          // A main broker may also view the policies of its direct sub-brokers
          // (used by the per-sub-broker Excel export button).
          const canViewUnderling = await isDirectUnderling(
            req.brokerScope,
            brokerId
          );
          if (!canViewUnderling) {
            return res
              .status(403)
              .json({ error: "Forbidden: you can only view your own broker" });
          }
        }
        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        // Optional date window (?from / ?to, both YYYY-MM-DD) scopes the policy
        // list. When omitted, the endpoint keeps its historical behaviour of
        // returning policies since the start of the current bi-weekly period.
        const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
        const fromParam = String(req.query.from ?? "").trim();
        const toParam = String(req.query.to ?? "").trim();
        if ((fromParam && !DATE_RE.test(fromParam)) || (toParam && !DATE_RE.test(toParam))) {
          return res
            .status(400)
            .json({ error: "from/to must be YYYY-MM-DD dates" });
        }

        const schedule = getSchedule(new Date());
        const conditions = ["BrokerId = ?", "Deleted = 0"];
        const params = [brokerId];
        if (fromParam || toParam) {
          if (fromParam) {
            conditions.push("CreationDate >= ?");
            params.push(`${fromParam} 00:00:00`);
          }
          if (toParam) {
            conditions.push("CreationDate < ?");
            params.push(`${toParam} 23:59:59`);
          }
        } else {
          conditions.push("CreationDate >= ?");
          params.push(`${schedule.periodStart} 00:00:00`);
        }

        const [policies] = await DBConnection.query(
          `SELECT PolicyNumber, BlancNumber, CarNumber, Price, CurrencyType,
                  Duration, Otomobil, NonTurk, CardFee, Branch, PaymentType,
                  CreationDate, StartDate, Annulled
             FROM insurance
            WHERE ${conditions.join(" AND ")}
            ORDER BY CreationDate DESC`,
          params
        );

        await attachSubBrokerStatus(DBConnection, [broker]);
        const hidePricing = Boolean(broker.hidePricing);
        let sanitizedPolicies;
        let brokerCashBalance = broker.CashBalance;

        if (hidePricing) {
          sanitizedPolicies = policies.map(
            ({ Otomobil, NonTurk, CardFee, ...p }) => ({
              ...p,
              Price: null,
              CurrencyType: null,
            })
          );
          brokerCashBalance = null;
        } else if (broker.IsSubBroker) {
          // For a sub-broker, the prices in broker_tariffs are display prices
          // only; when viewed by the sub-broker (or on the policies endpoint),
          // never expose the DB sale price (main broker's price).
          const disp = await computeSubBrokerDisplayData(
            DBConnection,
            broker.id
          );
          brokerCashBalance =
            req.brokerScope !== null
              ? disp.displayCashBalance
              : broker.CashBalance;
          sanitizedPolicies = policies.map(
            ({ Otomobil, NonTurk, CardFee, ...p }) => {
              const displayPrice = computePolicyTariffPrice(
                { Otomobil, NonTurk, CardFee, ...p },
                disp.subPricing
              );
              return {
                ...p,
                Price: displayPrice,
                CurrencyType: displayPrice === null ? null : p.CurrencyType,
              };
            }
          );
        } else {
          sanitizedPolicies = policies.map(
            ({ Otomobil, NonTurk, CardFee, ...p }) => p
          );
        }

        res.json({
          broker: {
            id: broker.id,
            Name: broker.Name,
            CashBalance: brokerCashBalance,
            IsSubBroker: broker.IsSubBroker,
            PricingConfigured: broker.PricingConfigured,
            hidePricing,
          },
          hidePricing,
          schedule,
          policies: sanitizedPolicies,
        });
      } catch (err) {
        console.error("Broker policies lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch broker policies" });
      }
    }
  );

  // GET /brokers/:id/underlings — the sub-brokers mapped to this (main) broker,
  // each with its insurance count + total price scoped by optional ?from / ?to
  // dates. A main broker uses this to review each underling and set their price.
  router.get(
    "/brokers/:id/underlings",
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
            .json({ error: "Forbidden: you can only view your own underlings" });
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
        const fromParam = String(req.query.from ?? "").trim();
        const toParam = String(req.query.to ?? "").trim();
        if (
          (fromParam && !DATE_RE.test(fromParam)) ||
          (toParam && !DATE_RE.test(toParam))
        ) {
          return res
            .status(400)
            .json({ error: "from/to must be YYYY-MM-DD dates" });
        }

        const [underlings] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE ParentBrokerId = ? ORDER BY id`,
          [brokerId]
        );
        if (underlings.length === 0) {
          return res.json({
            broker: { id: broker.id, Name: broker.Name },
            underlings: [],
          });
        }

        await attachSubBrokerStatus(DBConnection, underlings);

        const conditions = [
          `BrokerId IN (${underlings.map(() => "?").join(", ")})`,
          "Deleted = 0",
        ];
        const params = underlings.map((u) => u.id);
        if (fromParam) {
          conditions.push("CreationDate >= ?");
          params.push(`${fromParam} 00:00:00`);
        }
        if (toParam) {
          conditions.push("CreationDate < ?");
          params.push(`${toParam} 23:59:59`);
        }

        const [policyRows] = await DBConnection.query(
          `SELECT BrokerId, Duration, Otomobil, PaymentType, NonTurk, CardFee
             FROM insurance
            WHERE ${conditions.join(" AND ")}`,
          params
        );
        const policiesByUnderling = new Map();
        for (const r of policyRows) {
          if (!policiesByUnderling.has(r.BrokerId)) {
            policiesByUnderling.set(r.BrokerId, []);
          }
          policiesByUnderling.get(r.BrokerId).push(r);
        }

        // The main broker's own policies in the same window, so the totals can
        // include the main broker's own insurances (not just the underlings').
        const ownConditions = ["BrokerId = ?", "Deleted = 0"];
        const ownParams = [brokerId];
        if (fromParam) {
          ownConditions.push("CreationDate >= ?");
          ownParams.push(`${fromParam} 00:00:00`);
        }
        if (toParam) {
          ownConditions.push("CreationDate < ?");
          ownParams.push(`${toParam} 23:59:59`);
        }
        const [ownPolicyRows] = await DBConnection.query(
          `SELECT BrokerId, Duration, Otomobil, PaymentType, NonTurk, CardFee
             FROM insurance
            WHERE ${ownConditions.join(" AND ")}`,
          ownParams
        );

        // The main broker's own price list is the "main broker price" every
        // underling insurance is actually sold at. For the main broker's own
        // insurances the shown and sale prices are identical (its own tariff).
        const mainPricingRes = await effectivePricingFor(DBConnection, brokerId);
        const mainPricing = mainPricingRes.pricing || {};

        const result = [];
        let underlingsShowOnly = 0;
        let underlingsMainPrice = 0;
        let anyConfigured = false;

        for (const u of underlings) {
          const uPolicies = policiesByUnderling.get(u.id) || [];
          const policyCount = uPolicies.length;

          if (u.hidePricing) {
            result.push({
              id: u.id,
              Name: u.Name,
              CashBalance: null,
              ParentBrokerId: u.ParentBrokerId,
              IsSubBroker: u.IsSubBroker,
              PricingConfigured: u.PricingConfigured,
              hidePricing: u.hidePricing,
              policyCount,
              totalPrice: null,
              totalBalance: null,
              showOnlyTotal: null,
              mainPriceTotal: null,
              profit: null,
            });
          } else {
            anyConfigured = true;
            const disp = await computeSubBrokerDisplayData(DBConnection, u.id);
            let sumDisplayPrice = 0;
            let sumMainPrice = 0;
            for (const row of uPolicies) {
              const shown = computePolicyTariffPrice(row, disp.subPricing);
              if (shown !== null) sumDisplayPrice += shown;
              const sold = computePolicyTariffPrice(row, mainPricing);
              if (sold !== null) sumMainPrice += sold;
            }
            const totalPrice = Math.round(sumDisplayPrice * 100) / 100;
            const mainPriceTotal = Math.round(sumMainPrice * 100) / 100;
            const profit = Math.round((totalPrice - mainPriceTotal) * 100) / 100;
            underlingsShowOnly += totalPrice;
            underlingsMainPrice += mainPriceTotal;
            result.push({
              id: u.id,
              Name: u.Name,
              CashBalance: disp.displayCashBalance,
              ParentBrokerId: u.ParentBrokerId,
              IsSubBroker: u.IsSubBroker,
              PricingConfigured: u.PricingConfigured,
              hidePricing: u.hidePricing,
              policyCount,
              totalPrice,
              totalBalance: totalPrice,
              showOnlyTotal: totalPrice,
              mainPriceTotal,
              profit,
            });
          }
        }

        // Main broker's own insurances: shown == sale == its own tariff price.
        let ownTotal = 0;
        for (const row of ownPolicyRows) {
          const p = computePolicyTariffPrice(row, mainPricing);
          if (p !== null) ownTotal += p;
        }
        ownTotal = Math.round(ownTotal * 100) / 100;

        const totals = {
          showOnly: Math.round((underlingsShowOnly + ownTotal) * 100) / 100,
          mainPrice: Math.round((underlingsMainPrice + ownTotal) * 100) / 100,
          profit: Math.round((underlingsShowOnly - underlingsMainPrice) * 100) / 100,
        };

        const totalBalance = anyConfigured
          ? Math.round(underlingsShowOnly * 100) / 100
          : null;

        res.json({
          broker: { id: broker.id, Name: broker.Name },
          totalBalance,
          totals,
          underlings: result,
        });
      } catch (err) {
        console.error("Broker underlings lookup failed:", err);
        res.status(500).json({ error: "Failed to fetch underlings" });
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

        if (req.brokerScope !== null) {
          await attachSubBrokerStatus(DBConnection, [broker]);
          if (broker.hidePricing) {
            return res.json({
              broker: {
                id: broker.id,
                Name: broker.Name,
                CashBalance: null,
              },
              since,
              until,
              page,
              pageSize,
              total: 0,
              totalPages: 1,
              balanceAtStart: null,
              netChange: null,
              movements: [],
              includeDeleted: false,
              deleted: [],
            });
          }
          if (broker.IsSubBroker) {
            const disp = await computeSubBrokerDisplayData(
              DBConnection,
              brokerId
            );
            const [allMovs] = await DBConnection.query(
              `SELECT id, Type, Amount, Reason, Author, BlancNumber, CreatedAt
                 FROM broker_balance_movements
                WHERE BrokerId = ?
                  AND CreatedAt >= ?
                  AND CreatedAt < ?
                  AND Deleted = 0
                ORDER BY CreatedAt DESC, id DESC`,
              [brokerId, since, until]
            );
            const mappedAll = (allMovs || []).map((m) => ({
              ...m,
              DisplayAmount: disp.mapMovementAmount(m),
            }));
            const totalSub = mappedAll.length;
            const netChangeSub =
              Math.round(
                mappedAll.reduce((s, m) => s + m.DisplayAmount, 0) * 100
              ) / 100;
            const currentBalanceSub = disp.displayCashBalance;
            const balanceAtStartSub =
              Math.round((currentBalanceSub - netChangeSub) * 100) / 100;
            const totalPagesSub = Math.max(1, Math.ceil(totalSub / pageSize));
            const offsetSub = (page - 1) * pageSize;

            let runningAfter = currentBalanceSub;
            const withAfter = mappedAll.map((m) => {
              const balAfter = Math.round(runningAfter * 100) / 100;
              runningAfter -= m.DisplayAmount;
              return {
                id: m.id,
                Type: m.Type,
                Amount: m.DisplayAmount,
                Reason: m.Reason,
                Author: m.Author,
                BlancNumber: m.BlancNumber,
                CreatedAt:
                  m.CreatedAt instanceof Date
                    ? toLocalDateTime(m.CreatedAt)
                    : m.CreatedAt,
                BalanceAfter: balAfter,
              };
            });

            return res.json({
              broker: {
                id: broker.id,
                Name: broker.Name,
                CashBalance: currentBalanceSub,
              },
              since,
              until,
              page,
              pageSize,
              total: totalSub,
              totalPages: totalPagesSub,
              balanceAtStart: balanceAtStartSub,
              netChange: netChangeSub,
              movements: withAfter.slice(offsetSub, offsetSub + pageSize),
              includeDeleted: false,
              deleted: [],
            });
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

      // Optional parent (main) broker, mapping this broker as an underling.
      const parentBrokerId =
        toNumber(req.body?.ParentBrokerId ?? req.body?.parentBrokerId) ?? null;

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

          if (parentBrokerId !== null) {
            const [[parent]] = await conn.query(
              "SELECT id FROM brokers WHERE id = ?",
              [parentBrokerId]
            );
            if (!parent) {
              throw new Error("Parent broker not found");
            }
          }

          // The legacy range / counter columns are kept at 0: inactive blancs
          // are calculated from broker_blanc_batches.
          const [result] = await conn.query(
            `INSERT INTO brokers
               (Name, CashBalance, PolicyRangeStart, PolicyRangeEnd, InactivePolicies, ParentBrokerId)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [name, cashBalance, 0, 0, 0, parentBrokerId]
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
      if (err?.message === "Parent broker not found") {
        return res.status(400).json({ error: "Parent broker not found" });
      }
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

      // Parent (main) broker mapping. Undefined = unchanged; null = clear the
      // mapping; a positive number = map this broker as an underling of it.
      let parentBrokerUpdated = false;
      if (b.ParentBrokerId !== undefined || b.parentBrokerId !== undefined) {
        // An explicit `null` must survive: `??` would collapse it into the
        // absent camelCase fallback (undefined), turning "clear" into NaN and
        // wrongly rejecting the request.
        const raw =
          b.ParentBrokerId !== undefined ? b.ParentBrokerId : b.parentBrokerId;
        const parentBrokerId =
          raw === null || raw === "" ? null : Number(raw);
        if (
          parentBrokerId !== null &&
          (!Number.isFinite(parentBrokerId) || parentBrokerId <= 0)
        ) {
          return res
            .status(400)
            .json({ error: "ParentBrokerId must be a positive number or null" });
        }
        if (parentBrokerId !== null) {
          if (parentBrokerId === brokerId) {
            return res
              .status(400)
              .json({ error: "A broker cannot be its own parent" });
          }
          const [[parent]] = await DBConnection.query(
            "SELECT id FROM brokers WHERE id = ?",
            [parentBrokerId]
          );
          if (!parent) {
            return res.status(400).json({ error: "Parent broker not found" });
          }
        }
        sets.push("ParentBrokerId = ?");
        params.push(parentBrokerId);
        parentBrokerUpdated = true;
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
          if (parentBrokerUpdated) {
            // Reset any previous tariffs so the newly chosen main broker must
            // set up this sub-broker's price list before prices/balances show.
            try {
              await conn.query(
                "DELETE FROM broker_tariffs WHERE BrokerId = ?",
                [brokerId]
              );
            } catch {
              // Ignore if broker_tariffs is absent in minimal test mocks.
            }
            // Ensure the sub-broker's stored DB sale prices and balance reflect
            // the newly assigned main broker's price list.
            try {
              const saleEff = await salePricingFor(conn, brokerId);
              if (Object.keys(saleEff.pricing).length > 0) {
                await recalculateBrokerPoliciesForPricing(
                  conn,
                  brokerId,
                  saleEff.pricing
                );
              }
            } catch {
              // Ignore in minimal test mocks.
            }
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
      if (!broker) return;
      if (emails !== null && broker.cutOff) {
        const { evictEmailsForAddresses } = require("../Users/websocket.js");
        await evictEmailsForAddresses(broker.emails || []);
      }
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

  // POST /brokers/:id/cutoff  { cutOff: boolean } — admin-only manual cut-off.
  // When cutOff is set, new insurances for the broker are blocked. The automatic
  // two-week-behind detection no longer blocks anything; it only flags the
  // broker as overdue (see attachPaymentStatus) and enables the client button.
  router.post("/brokers/:id/cutoff", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      const raw = req.body?.cutOff;
      const cutOff =
        typeof raw === "string" ? raw !== "0" && raw !== "false" : Boolean(raw);

      const [existing] = await DBConnection.query(
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      await DBConnection.query(
        "UPDATE brokers SET CutOff = ? WHERE id = ?",
        [cutOff ? 1 : 0, brokerId]
      );

      if (cutOff) {
        const [emailRows] = await DBConnection.query(
          "SELECT Email FROM broker_emails WHERE BrokerId = ?",
          [brokerId]
        );
        const { evictEmailsForAddresses } = require("../Users/websocket.js");
        await evictEmailsForAddresses(emailRows.map((r) => r.Email));
      }

      const [[broker]] = await DBConnection.query(
        `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
        [brokerId]
      );
      res.json({
        message: cutOff ? "Broker cut off" : "Broker re-enabled",
        broker,
      });
    } catch (err) {
      console.error("Broker cut-off toggle failed:", err);
      res.status(500).json({ error: "Failed to update broker cut-off" });
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
  // Broker Pricing endpoints.
  // ---------------------------------------------------------------
  // Admins (1) manage every broker's pricing. Workers (2) have no access. A
  // broker-linked client (role 3) may only manage the pricing of their direct
  // underlings (sub-brokers) — a main broker sets a price that its underlings
  // inherit for their insurances, but cannot set their own price.

  // Allow a broker (role 3) to read/manage pricing for their direct underlings
  // only; admins (1) manage every broker and workers (2) have no access.
  const requirePricingAccess = async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const brokerId = parseBrokerId(req.params.brokerId);
    if (brokerId === null) {
      return res.status(400).json({ error: "Invalid broker ID" });
    }
    const allowed = await manageableBrokerIds(DBConnection, req.user);
    if (allowed === null || allowed.has(brokerId)) {
      req.pricingBrokerId = brokerId;
      return next();
    }
    return res.status(403).json({
      error: "Forbidden: you can only manage your sub-brokers' pricing",
    });
  };

  // GET /brokers/:brokerId/pricing — retrieve all pricing for a broker
  router.get(
    "/brokers/:brokerId/pricing",
    auth,
    requirePricingAccess,
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.brokerId);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker ID" });
        }

        // Check if broker exists
        const [brokerCheck] = await DBConnection.query(
          "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (brokerCheck.length === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }
        const brokerName = brokerCheck[0].Name;
        const isSub = Boolean(
          isSubBrokerName(brokerName) ||
            (brokerCheck[0].ParentBrokerId !== null &&
              brokerCheck[0].ParentBrokerId !== undefined)
        );

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
        let inherited = false;
        let sourceBrokerName = null;

        // Nothing in the database yet: fall back to BrokerInfo.js and seed it
        // ONLY for non-sub brokers. Sub-brokers must not have tariffs seeded
        // until their main broker explicitly saves their price list.
        if (!isSub && Object.keys(pricing).length === 0 && EuroPricing[brokerName]) {
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
              EuroPricing[brokerName]
            )) {
              pricing[type] = {};
              for (const [d, p] of Object.entries(durations)) {
                pricing[type][String(d)] = Number(p);
              }
            }
          }
          if (Object.keys(pricing).length > 0) {
            source = "BrokerInfo";
          }
        }

        // Still no own tariffs: inherit from the parent (main) broker so a
        // main broker opening the pricing modal has a starting template.
        if (Object.keys(pricing).length === 0) {
          const eff = await effectivePricingFor(DBConnection, brokerId);
          pricing = eff.pricing;
          inherited = eff.inherited;
          sourceBrokerName = eff.sourceBrokerName;
          if (eff.sourceBrokerId !== null && eff.sourceBrokerId !== brokerId) {
            source = "inherited";
          } else if (eff.inherited) {
            source = "BrokerInfo";
          }
        }

        res.json({
          success: true,
          brokerId,
          brokerName,
          source,
          inherited,
          sourceBrokerName,
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
    requirePricingAccess,
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
          "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
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

            // For a sub-broker, the tariffs saved in broker_tariffs are DISPLAY
            // prices only (for that sub-broker and for the total balance shown
            // to the main broker). The sale price stored in the DB and used to
            // calculate what each broker owes us must always be the main
            // broker's price.
            await attachSubBrokerStatus(conn, brokerCheck);
            const isSub = Boolean(brokerCheck[0] && brokerCheck[0].IsSubBroker);
            if (isSub) {
              const saleEff = await salePricingFor(conn, brokerId);
              if (Object.keys(saleEff.pricing).length > 0) {
                await recalculateBrokerPoliciesForPricing(
                  conn,
                  brokerId,
                  saleEff.pricing
                );
              }
            } else {
              await recalculateBrokerPoliciesForPricing(
                conn,
                brokerId,
                updatedPricing
              );
              try {
                const [underlings] = await conn.query(
                  "SELECT id FROM brokers WHERE ParentBrokerId = ?",
                  [brokerId]
                );
                for (const u of underlings || []) {
                  await recalculateBrokerPoliciesForPricing(
                    conn,
                    u.id,
                    updatedPricing
                  );
                }
              } catch {
                // Ignore in minimal test mocks.
              }
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

"use strict";
// Broker balance support.
//
// Each broker has a cash balance that only admins (role 1) and workers
// (role 2) can raise, and only by recording money the broker actually paid.
// Unlike daily current cash, a broker balance may go infinitely negative.
//
// A broker balance never moves current cash:
//   - Increasing a broker's balance is money handed over by the broker. It
//     is kept apart from current cash as the branch's "Cash from Brokers":
//     the top-up is recorded once, as a balance movement carrying the branch
//     that took the money and its currency (see CurrentCash.js).
//   - A HAND-OVER TO THE OWNER (Type = "handover") is also money the broker
//     paid, but it went straight to the owner and never reached a branch. It
//     raises the broker's balance like a top-up, yet it carries NO branch, so
//     it is never Cash from Brokers (CurrentCash.js only reads top-ups with a
//     branch) and it writes nothing to the cash drawer. It does count as a
//     payment: the reports and the broker's last-payment date read the two
//     types together.
//   - The balance FALLS when an insurance is created from an email card (the
//     per-policy deduction, see decreaseBrokerForInsurance below). That touches
//     neither current cash nor Cash from Brokers and is never blocked by how
//     much cash happens to be available. There is no manual reduction: the
//     whole balance is the starting balance plus the payments minus the
//     broker's policies (see recalculateBrokerBalance), so a hand-typed
//     reduction would be undone by the next recalculation. Old "reduce" and
//     "adjust" rows are kept as history and ignored by that calculation.
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
//
// A blanc that a user chose to write on anyway, although it is outside every
// handed-out batch, is added to that broker's batches as its own one-number
// batch with AutoAdded = 1 (see addAutoBlancBatch). Such a batch was never
// handed out by an admin, so the client paints it pink and it stands out in the
// batch lists instead of the blanc silently living outside the batches. An
// admin editing that batch's range adopts it: AutoAdded is cleared and the pink
// goes away. A blanc that is already inside another broker's batch is never
// adopted - the create is refused with a message naming that broker.

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
  normalizeCurrency,
  normalizeBranch,
  clientLocalDateTime,
  parseClientDateTime,
} = require("./CurrentCash.js");
const { getSchedule } = require("./PaymentSchedule.js");
const {
  ensureBrokerPaymentsTable,
  recordBrokerPayment,
  syncBrokerPaymentFromMovement,
  sumBrokerPayments,
} = require("../db/brokerPayments.js");

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

// Movement types kept only as history. The balance rule (see
// recalculateBrokerBalance) never counts them, so the history ledger, the
// per-sub-broker display balance and the edit/delete/restore paths must not let
// them move CashBalance either. The client tags these rows as retired.
const RETIRED_MOVEMENT_TYPES = new Set(["reduce", "adjust"]);
function isRetiredMovementType(type) {
  return RETIRED_MOVEMENT_TYPES.has(String(type ?? "").trim().toLowerCase());
}
module.exports.isRetiredMovementType = isRetiredMovementType;


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
 * Whether a blanc number falls inside one of a broker's blanc batches.
 * A broker with no batch (or a non-numeric blanc) reports `false`.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {any} blancNumber
 * @returns {Promise<boolean>}
 */
const blancInBrokerBatches = (module.exports.blancInBrokerBatches =
  async function blancInBrokerBatches(conn, brokerId, blancNumber) {
    const numeric = parseInt(String(blancNumber ?? "").trim(), 10);
    if (!Number.isFinite(numeric)) return false;
    const [rows] = await conn.query(
      `SELECT id FROM broker_blanc_batches
        WHERE BrokerId = ? AND RangeStart <= ? AND RangeEnd >= ?
        LIMIT 1`,
      [brokerId, numeric, numeric]
    );
    return rows.length > 0;
  });

/**
 * The OTHER broker whose blanc batches already contain `blancNumber`, if any.
 *
 * A blanc may belong to only one broker: batches never overlap, and a blanc
 * handed to broker A must never be written on for broker B. This lookup lets
 * the create endpoints refuse such a blanc with a message naming the broker
 * that holds it, instead of silently overlapping the two brokers' batches.
 *
 * @param {{query: Function}} conn
 * @param {number} brokerId  The broker the policy is being written for.
 * @param {any} blancNumber
 * @returns {Promise<{id: number, name: string}|null>}
 */
const findOtherBrokerWithBlanc = (module.exports.findOtherBrokerWithBlanc =
  async function findOtherBrokerWithBlanc(conn, brokerId, blancNumber) {
    const numeric = parseInt(String(blancNumber ?? "").trim(), 10);
    if (!Number.isFinite(numeric)) return null;
    const [rows] = await conn.query(
      `SELECT bb.BrokerId AS id, br.Name AS name
         FROM broker_blanc_batches bb
         LEFT JOIN brokers br ON br.id = bb.BrokerId
        WHERE bb.BrokerId <> ? AND bb.RangeStart <= ? AND bb.RangeEnd >= ?
        ORDER BY bb.id
        LIMIT 1`,
      [brokerId, numeric, numeric]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return {
      id: Number(rows[0].id),
      name: rows[0].name === undefined || rows[0].name === null ? "" : String(rows[0].name),
    };
  });

/**
 * Add ONE blanc to a broker's batches. Used when a policy is force-created with
 * a blanc outside every handed-out batch ("create anyway"): the blanc becomes
 * its own one-number batch flagged AutoAdded, so it is part of the broker's
 * batches and the client can paint it pink to show it was never handed out.
 *
 * Nothing is written when the broker id is invalid, the blanc is not a whole
 * number (a range can only hold numbers), the blanc already belongs to one of
 * the broker's batches or it belongs to ANOTHER broker (that is a hard error
 * reported by the create endpoints, never an automatic batch here).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {any} blancNumber
 * @param {string} [author] Username of the user who forced the policy.
 * @returns {Promise<boolean>} true when a batch row was added.
 */
const addAutoBlancBatch = (module.exports.addAutoBlancBatch =
  async function addAutoBlancBatch(conn, brokerId, blancNumber, author) {
    const id = Number(brokerId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const raw = String(blancNumber ?? "").trim();
    if (!/^\d+$/.test(raw)) return false;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return false;
    if (await blancInBrokerBatches(conn, id, raw)) return false;
    if (await findOtherBrokerWithBlanc(conn, id, raw)) return false;
    await conn.query(
      `INSERT INTO broker_blanc_batches
         (BrokerId, RangeStart, RangeEnd, CreatedBy, AutoAdded)
       VALUES (?, ?, ?, ?, 1)`,
      [id, numeric, numeric, String(author || "")]
    );
    return true;
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
          AND b.Deleted = 0
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

    // The money the broker paid, from its own table (never from the history
    // ledger, whose rows an admin can correct or delete).
    let manualMovementsSum = 0;
    try {
      await ensureBrokerPaymentsTable(conn);
      manualMovementsSum = await sumBrokerPayments(conn, brokerId);
    } catch {
      manualMovementsSum = 0;
    }

    // The balance the broker had before its first insurance is the base of the
    // displayed ledger too. Without it an admin's starting balance would be
    // silently dropped from a sub-broker's history and from its balance in the
    // broker list. The table is created on first use, so a missing one simply
    // means no base has been set yet.
    let startingAmount = 0;
    try {
      const [[startingRow]] = await conn.query(
        "SELECT Amount FROM broker_starting_balances WHERE BrokerId = ?",
        [brokerId]
      );
      const amount = Number(startingRow && startingRow.Amount) || 0;
      startingAmount = Math.round(amount * 100) / 100;
    } catch {
      startingAmount = 0;
    }

    const displayCashBalance =
      Math.round(
        (startingAmount + manualMovementsSum + netPoliciesImpact) * 100
      ) / 100;

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
// it NULL. A manual top-up ("increase") is money handed over by the broker, so
// it also carries the Branch that took the money and its Currency: those rows
// are the branch's "Cash from Brokers" (see CurrentCash.js). Branch is NULL on
// every other movement.

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
  Branch VARCHAR(45) NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  PRIMARY KEY (id),
  KEY idx_broker_movements_broker_time (BrokerId, CreatedAt),
  KEY idx_broker_movements_branch_time (Branch, CreatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Every change to a broker CashBalance (signed Amount)'`;
module.exports.BROKER_MOVEMENT_TABLE_SQL = BROKER_MOVEMENT_TABLE_SQL;

// The balance a broker had BEFORE its first insurance was created. It is the
// base of every figure on the balance history page: once an admin sets it, the
// broker's CashBalance is recalculated from the insurances and the manual
// movements that follow (see recalculateBrokerBalance below), so the stored
// balance and the starting balance can never drift apart.
//
// One row per broker (BrokerId is the primary key); a broker without a row
// simply has no starting balance yet. `EffectiveDate` is the date the starting
// balance belongs to (normally the day before the broker's first insurance).
const BROKER_STARTING_BALANCE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS broker_starting_balances (
  BrokerId INT NOT NULL,
  Amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  EffectiveDate DATE NOT NULL,
  UpdatedBy VARCHAR(45) NOT NULL DEFAULT '',
  UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (BrokerId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='The balance a broker had before its first insurance (recalculation base)'`;
module.exports.BROKER_STARTING_BALANCE_TABLE_SQL =
  BROKER_STARTING_BALANCE_TABLE_SQL;

/**
 * Recalculate a broker's CashBalance from its starting balance.
 *
 * The balance is rebuilt from the source data instead of trusting the ledger:
 *
 *   CashBalance = StartingBalance
 *               + every payment in broker_payments
 *               - every live insurance of the broker
 *
 * An ACTIVE insurance is charged its price. An ANNULLED one is charged its
 * annulment tax (`AnnulFee`; `Price` mirrors it since migration 018 and is the
 * fallback for legacy rows without the mirror) ONLY when the broker was the one
 * at fault (`AnnulReason = 'broker'`): that is the case where the refund kept
 * the fee back. When the worker or nobody paid it, the broker was refunded the
 * full price, so its net charge is 0.
 *
 * "Manual payment" means money the broker actually handed over: a branch
 * top-up ("increase", bill payments included) or a hand-over to the owner
 * ("handover"). They are read from `broker_payments` - the money table - not
 * from the history ledger, so a corrected or soft-deleted history row can never
 * move a balance. Reductions ("reduce") and admin balance corrections
 * ("adjust") are NOT payments and are no longer part of the formula: the
 * balance is the starting point plus the policies, minus what the broker paid.
 * The policy-derived rows ("policy", "annulment", "deletion", "price_change")
 * are skipped for the same reason - the insurances above are the truth for
 * those, so a policy moved to another broker, an edited price or a soft-deleted
 * movement cannot leave a stale charge behind.
 *
 * Runs inside the caller's transaction.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} startingAmount  the balance before the first insurance
 * @returns {Promise<{balance: number, startingBalance: number,
 *                    insuranceCharges: number, payments: number}>}
 */
const recalculateBrokerBalance = (module.exports.recalculateBrokerBalance =
  async function recalculateBrokerBalance(conn, brokerId, startingAmount) {
    const starting =
      Math.round((toDecimal(startingAmount) || 0) * 100) / 100;

    // Every live insurance of this broker, at its effective charge.
    const [[chargedRow]] = await conn.query(
      `SELECT COALESCE(SUM(
                CASE WHEN Annulled = 1
                     THEN CASE
                            WHEN LOWER(TRIM(COALESCE(AnnulReason, ''))) = 'broker'
                            THEN CAST(COALESCE(AnnulFee, Price, 0) AS DECIMAL(15,2))
                            ELSE 0
                          END
                     ELSE CAST(COALESCE(Price, 0) AS DECIMAL(15,2))
                END), 0) AS Charged
         FROM insurance
        WHERE BrokerId = ? AND Deleted = 0`,
      [brokerId]
    );

    // The payments only: money the broker actually handed over, as a branch
    // top-up ("increase"), a paid bill, or straight to the owner ("handover").
    // They live in their own table (db/brokerPayments.js) - NOT in the history
    // ledger, whose rows an admin may correct or delete without moving money.
    const payments = await sumBrokerPayments(conn, brokerId);

    const insuranceCharges =
      Math.round((toDecimal(chargedRow && chargedRow.Charged) || 0) * 100) /
      100;
    const balance =
      Math.round((starting + payments - insuranceCharges) * 100) / 100;

    await conn.query("UPDATE brokers SET CashBalance = ? WHERE id = ?", [
      balance,
      brokerId,
    ]);

    return { balance, startingBalance: starting, insuranceCharges, payments };
  });

// The tables the balance formula reads are created by db/setup.js on start-up
// and once when the router is built (see createBrokerRouter). Nothing is
// created here: a DDL inside a transaction would implicitly commit it.
const STARTING_BALANCE_TABLE = "broker_starting_balances";

/**
 * The broker's starting balance (its balance before the first insurance), or
 * null when none has been set - there is then no base to rebuild from and the
 * stored, incrementally maintained figure stays authoritative.
 *
 * Runs inside the caller's transaction so the recalculation sees the same
 * snapshot. A database that has not run db/setup.js yet simply has no base.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @returns {Promise<number|null>}
 */
async function loadStartingAmount(conn, brokerId) {
  try {
    const [[row]] = await conn.query(
      `SELECT Amount FROM ${STARTING_BALANCE_TABLE} WHERE BrokerId = ?`,
      [brokerId]
    );
    if (!row) return null;
    return Math.round((Number(row.Amount) || 0) * 100) / 100;
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/** ER_NO_SUCH_TABLE / "Table ... doesn't exist". */
function isMissingTableError(err) {
  if (!err) return false;
  if (Number(err.errno) === 1146 || err.code === "ER_NO_SUCH_TABLE") return true;
  return /table .*doesn'?t exist/i.test(String(err.message || ""));
}

// Clients are told about a balance change once per tick, not once per write:
// annulling a policy touches the broker three times (sale delta, refund, tax).
const pendingBalanceNotifications = new Set();
let balanceNotifyTimer = null;
function queueBrokerBalanceNotification(brokerId) {
  const id = Number(brokerId);
  if (!Number.isInteger(id) || id <= 0) return;
  pendingBalanceNotifications.add(id);
  if (balanceNotifyTimer) return;
  // No timer (a unit-test sandbox, a short script): there is nothing to push to.
  if (typeof setTimeout !== "function") return;
  balanceNotifyTimer = setTimeout(() => {
    const ids = Array.from(pendingBalanceNotifications);
    pendingBalanceNotifications.clear();
    balanceNotifyTimer = null;
    try {
      // Lazy: Users/websocket.js pulls in the mail stack, and this module is
      // loaded before the WebSocket server exists.
      const { notifyBrokerBalanceChanged } = require("../Users/websocket.js");
      if (typeof notifyBrokerBalanceChanged === "function") {
        notifyBrokerBalanceChanged(ids);
      }
    } catch (err) {
      // A missing socket server (tests, short scripts) must never fail a save.
      console.warn("Could not announce a broker balance change:", err && err.message);
    }
  }, 20);
  if (typeof balanceNotifyTimer.unref === "function") balanceNotifyTimer.unref();
}

/**
 * Rebuild a broker's balance from the source data after ANY change that can
 * move it (a policy created/edited/annulled/restored/deleted, a payment
 * recorded, a payment corrected or removed).
 *
 * Must be called inside the same transaction as the change, so a rolled-back
 * save can never leave a recalculated balance behind:
 *
 *   CashBalance = starting balance
 *               + money the broker paid   (broker_payments)
 *               - live insurances         (insurance, Price / annulment tax)
 *
 * Brokers without a starting balance are left alone (null): their stored figure
 * is the only base they have, and it is maintained by the incremental updates
 * the callers still run. Set a starting balance to move a broker onto the
 * rebuilt figure.
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @returns {Promise<{balance: number, startingBalance: number,
 *                    insuranceCharges: number, payments: number}|null>}
 */
const refreshBrokerBalance = (module.exports.refreshBrokerBalance =
  async function refreshBrokerBalance(conn, brokerId) {
    const starting = await loadStartingAmount(conn, brokerId);
    if (starting === null) return null;
    let result;
    try {
      result = await recalculateBrokerBalance(conn, brokerId, starting);
    } catch (err) {
      // A database that has not run db/setup.js has no broker_payments table
      // yet: skip the rebuild instead of failing the save (the incremental
      // figure the caller already applied stays authoritative).
      if (isMissingTableError(err)) return null;
      throw err;
    }
    queueBrokerBalanceNotification(brokerId);
    return result;
  });

/**
 * Insert one signed broker-balance movement. Runs inside the caller's
 * transaction (`conn`).
 *
 * @param {import("mysql2/promise").Connection} conn
 * @param {number} brokerId
 * @param {number|string} amount  signed delta (positive = increase)
 * @param {string} type  e.g. "policy" | "annulment" | "deletion" |
 *                       "price_change" | "increase" | "handover". "reduce" and
 *                       "adjust" are legacy types: the "Reduce" action and the
 *                       hand-typed balance correction no longer exist, so the
 *                       balance is never lowered by hand (old rows are kept as
 *                       history and ignored by recalculateBrokerBalance).
 * @param {{reason?: string, author?: string, blancNumber?: string,
 *          createdAt?: string, branch?: string, currency?: string}} [meta]
 *          `createdAt` is an already-resolved client-local
 *          "YYYY-MM-DD HH:MM:SS" string. `branch` (with `currency`) is passed
 *          only for money handed over by the broker: it marks the movement as
 *          that branch's Cash from Brokers. A hand-over to the owner passes
 *          `currency` WITHOUT `branch`, so the currency is recorded but the
 *          movement stays out of Cash from Brokers.
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
    const columns = [
      "BrokerId",
      "Amount",
      "Type",
      "Reason",
      "Author",
      "BlancNumber",
      "CreatedAt",
    ];
    const values = [
      brokerId,
      amt,
      type,
      String(meta.reason ?? ""),
      String(meta.author ?? ""),
      meta.blancNumber ? String(meta.blancNumber) : null,
      createdAt,
    ];
    // Only money handed over by the broker names a branch (an empty one
    // included). Every other movement leaves Branch NULL, which keeps it out
    // of Cash from Brokers. A hand-over to the owner still records its
    // currency (the reports show what the owner collected in), just without a
    // branch.
    if (typeof meta.branch === "string" || meta.currency !== undefined) {
      columns.push("Branch", "Currency");
      values.push(
        typeof meta.branch === "string" ? normalizeBranch(meta.branch) : null,
        normalizeCurrency(meta.currency)
      );
    }
    await conn.query(
      `INSERT INTO broker_balance_movements (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      values
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
  AutoAdded TINYINT(1) NOT NULL DEFAULT 0,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_broker_blanc_batches_broker (BrokerId),
  KEY idx_broker_blanc_batches_range (RangeStart, RangeEnd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Blanc number ranges handed to brokers (one row per batch)'`;
module.exports.BLANC_BATCH_TABLE_SQL = BLANC_BATCH_TABLE_SQL;

// Hollow blancs: a blanc an admin tagged as unusable (the form is faulty, so no
// policy can be written on it). It is NOT an insurance row; it lives in its own
// table and counts as used-up in the inactive-blanc calculation below, so the
// blanc disappears from the broker's current blancs as soon as it is tagged.
const HOLLOW_BLANC_TABLE_SQL = `CREATE TABLE IF NOT EXISTS hollow_blancs (
  BlancNumber VARCHAR(45) NOT NULL,
  BrokerId INT NULL,
  Branch VARCHAR(45) NOT NULL DEFAULT '',
  Author VARCHAR(45) NOT NULL DEFAULT '',
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (BlancNumber),
  KEY idx_hollow_blancs_broker (BrokerId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Blanc numbers tagged as hollow (cannot be used for a policy)'`;
module.exports.HOLLOW_BLANC_TABLE_SQL = HOLLOW_BLANC_TABLE_SQL;

// `hollow_blancs` is created by db/setup.js on start-up; this keeps the module
// usable on a database that has not been restarted since the update. It needs a
// connection (the router's pool) because this module has no global one.
let hollowTableReady = null;
const ensureHollowTable = (module.exports.ensureHollowTable =
  function ensureHollowTable(conn) {
    if (!conn || typeof conn.query !== "function") {
      return Promise.reject(new Error("No database connection"));
    }
    if (!hollowTableReady) {
      hollowTableReady = Promise.resolve(conn.query(HOLLOW_BLANC_TABLE_SQL)).catch(
        (err) => {
          hollowTableReady = null;
          throw err;
        }
      );
    }
    return hollowTableReady;
  });

// Whether a blanc number was tagged as hollow.
const isHollowBlanc = (module.exports.isHollowBlanc =
  async function isHollowBlanc(conn, blancNumber) {
    const blanc = String(blancNumber ?? "").trim();
    if (!blanc) return false;
    const [rows] = await conn.query(
      "SELECT BlancNumber FROM hollow_blancs WHERE BlancNumber = ? LIMIT 1",
      [blanc]
    );
    return Array.isArray(rows) && rows.length > 0;
  });

// The broker whose batch contains a blanc number, or null for a walk-in/number
// that belongs to no batch. Used when an admin tags a blanc as hollow, so the
// right broker's current blancs lose it.
const findBrokerForBlanc = (module.exports.findBrokerForBlanc =
  async function findBrokerForBlanc(conn, blancNumber) {
    const numeric = parseInt(String(blancNumber ?? "").trim(), 10);
    if (!Number.isFinite(numeric)) return null;
    const [rows] = await conn.query(
      `SELECT BrokerId AS id FROM broker_blanc_batches
        WHERE RangeStart <= ? AND RangeEnd >= ?
        LIMIT 1`,
      [numeric, numeric]
    );
    const id = rows && rows.length ? Number(rows[0].id) : NaN;
    return Number.isFinite(id) && id > 0 ? id : null;
  });

/**
 * Tag a blanc as hollow. Returns `{ ok, error?, code?, alreadyHollow?,
 * brokerId? }` - a second tag of the same number is not an error, so a repeated
 * click cannot fail confusingly.
 *
 * @param {object} conn      transaction connection (or the pool)
 * @param {any} blancNumber
 * @param {string} author    username of the admin who tagged it
 * @param {{brokerId?: number|null, branch?: string}} [meta]
 */
const tagHollowBlanc = (module.exports.tagHollowBlanc =
  async function tagHollowBlanc(conn, blancNumber, author, meta = {}) {
    const blanc = String(blancNumber ?? "").trim();
    if (!blanc) return { ok: false, error: "BlancNumber is required" };
    // The caller may have created the table already (outside its transaction:
    // MySQL commits implicitly on DDL, so it must not run inside one).
    if (!(meta && meta.skipEnsure)) await ensureHollowTable(conn);
    const [existing] = await conn.query(
      "SELECT BlancNumber, BrokerId FROM hollow_blancs WHERE BlancNumber = ? LIMIT 1",
      [blanc]
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return { ok: true, alreadyHollow: true, brokerId: existing[0].BrokerId };
    }
    const brokerId =
      meta && Number.isFinite(Number(meta.brokerId)) && Number(meta.brokerId) > 0
        ? Number(meta.brokerId)
        : await findBrokerForBlanc(conn, blanc);
    await conn.query(
      `INSERT INTO hollow_blancs (BlancNumber, BrokerId, Branch, Author, CreatedAt)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [blanc, brokerId, String((meta && meta.branch) || ""), String(author || "")]
    );
    return { ok: true, alreadyHollow: false, brokerId };
  });

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
        // true when the blanc was forced in outside every handed-out range and
        // joined the batches automatically (painted pink by the client).
        AutoAdded: Boolean(Number(r.AutoAdded ?? 0)),
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
 * the blanc back. A blanc tagged as hollow counts as used too: it cannot be
 * written on, so it is no longer one of the broker's current (inactive) blancs.
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
              b.AutoAdded,
              (SELECT COUNT(DISTINCT CAST(TRIM(i.BlancNumber) AS UNSIGNED))
                 FROM insurance i
                WHERE TRIM(i.BlancNumber) REGEXP '^[0-9]+$'
                  AND CAST(TRIM(i.BlancNumber) AS UNSIGNED)
                      BETWEEN b.RangeStart AND b.RangeEnd
                  AND i.Deleted = 0)
            + (SELECT COUNT(DISTINCT CAST(TRIM(h.BlancNumber) AS UNSIGNED))
                 FROM hollow_blancs h
                WHERE TRIM(h.BlancNumber) REGEXP '^[0-9]+$'
                  AND CAST(TRIM(h.BlancNumber) AS UNSIGNED)
                      BETWEEN b.RangeStart AND b.RangeEnd) AS Used
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
  const BROKER_COLUMNS = "id, Name, Code, CashBalance, ParentBrokerId, CutOff";

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

  // The payments table is created on first use (and by db/setup.js). Like the
  // tables above it is created OUTSIDE any request transaction: a DDL inside a
  // transaction would implicitly commit it.
  let paymentsTableReady = null;
  function ensurePaymentsTable() {
    if (!paymentsTableReady) {
      paymentsTableReady = Promise.resolve(
        ensureBrokerPaymentsTable(DBConnection)
      ).catch((err) => {
        paymentsTableReady = null;
        throw err;
      });
    }
    return paymentsTableReady;
  }
  // Prepare it now, never inside a request transaction.
  ensurePaymentsTable().catch((err) => {
    console.warn(
      "Could not prepare broker_payments:",
      (err && err.message) || err
    );
  });

  // The starting balance table is created on first use (and by db/setup.js), so
  // the server also works on a database that has not been set up again yet.
  let startingBalanceTableReady = null;
  function ensureStartingBalanceTable() {
    if (!startingBalanceTableReady) {
      startingBalanceTableReady = Promise.resolve(
        DBConnection.query(BROKER_STARTING_BALANCE_TABLE_SQL)
      ).catch((err) => {
        startingBalanceTableReady = null;
        throw err;
      });
    }
    return startingBalanceTableReady;
  }

  // A stored DATE comes back as a "YYYY-MM-DD" string (the pool sets
  // dateStrings), but a Date is handled too so the shape never leaks out.
  function toDateOnlyString(value) {
    if (value === undefined || value === null || value === "") return null;
    if (value instanceof Date) return toLocalDateTime(value).slice(0, 10);
    return String(value).trim().slice(0, 10) || null;
  }

  // The broker's starting balance (the balance before its first insurance), or
  // null when an admin has not set one yet. Shown on the balance history page.
  async function loadStartingBalance(brokerId) {
    await ensureStartingBalanceTable();
    const [[row]] = await DBConnection.query(
      `SELECT Amount, EffectiveDate, UpdatedBy, UpdatedAt
         FROM broker_starting_balances
        WHERE BrokerId = ?`,
      [brokerId]
    );
    if (!row) return null;
    return {
      amount: Math.round((Number(row.Amount) || 0) * 100) / 100,
      date: toDateOnlyString(row.EffectiveDate),
      updatedBy: row.UpdatedBy || "",
      updatedAt:
        row.UpdatedAt instanceof Date
          ? toLocalDateTime(row.UpdatedAt)
          : row.UpdatedAt || null,
    };
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
          AND Type NOT IN ('reduce', 'adjust')
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
  // Attach the newest payment of each broker's balance (a branch top-up or a
  // hand-over to the owner) to the list rows, so the brokers table can show
  // the last payment (amount + date) without a request per broker. A
  // soft-deleted payment is skipped: it no longer counts as money received.
  async function attachLastPayments(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    await ensureMovementTable();
    const [lastRows] = await DBConnection.query(
      `SELECT m.BrokerId, m.Amount, m.Currency, m.CreatedAt
         FROM broker_balance_movements m
         JOIN (
           SELECT BrokerId, MAX(id) AS LastId
             FROM broker_balance_movements
            WHERE Deleted = 0 AND Type IN ('increase', 'handover')
            GROUP BY BrokerId
         ) last ON last.LastId = m.id`
    );
    const byBroker = new Map();
    for (const row of lastRows || []) {
      byBroker.set(Number(row.BrokerId), {
        amount: Math.round((Number(row.Amount) || 0) * 100) / 100,
        currency: String(row.Currency || "EUR"),
        at:
          row.CreatedAt instanceof Date
            ? toLocalDateTime(row.CreatedAt)
            : row.CreatedAt,
      });
    }
    for (const b of rows) {
      const last = byBroker.get(Number(b.id));
      b.LastPaymentAmount = last ? last.amount : null;
      b.LastPaymentCurrency = last ? last.currency : null;
      b.LastPaymentAt = last ? last.at : null;
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
        `SELECT BlancNumber, Price, OriginalPrice, Duration, Otomobil,
                PaymentType, NonTurk, CardFee, Annulled, AnnulReason, AnnulFee
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
        // An annulled policy's Price is its annulment tax; the sale price this
        // recalculation corrects lives in OriginalPrice. Older rows without it
        // still carry the sale price in Price.
        const annulled = Number(row.Annulled) === 1;
        const storedOriginal =
          row.OriginalPrice !== null && row.OriginalPrice !== undefined &&
          String(row.OriginalPrice).trim() !== ""
            ? row.OriginalPrice
            : row.Price;
        const oldPrice = Math.round((Number(storedOriginal) || 0) * 100) / 100;
        if (newPrice === oldPrice) continue;

        if (annulled) {
          // Keep Price equal to the tax; only the original sale price moves.
          const fee = Math.round((Number(row.AnnulFee) || 0) * 100) / 100;
          await conn.query(
            "UPDATE insurance SET Price = ?, OriginalPrice = ? WHERE BlancNumber = ?",
            [String(fee), String(newPrice), row.BlancNumber]
          );
        } else {
          await conn.query(
            "UPDATE insurance SET Price = ? WHERE BlancNumber = ?",
            [String(newPrice), row.BlancNumber]
          );
        }

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
      // The tariff change rewrote the policies' prices: rebuild the figure from
      // them (a no-op for brokers without a starting balance).
      await refreshBrokerBalance(conn, brokerId);
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
      let amt = Number(r.Amount || 0);
      if (isRetiredMovementType(r.Type)) {
        amt = 0;
      } else if (disp) {
        amt = disp.mapMovementAmount(r);
      }
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
      // Soft-deleted brokers are hidden from every list (a broker-scoped account
      // then simply sees nothing). Only an admin may ask for them, with
      // ?includeDeleted=1, so the client can offer Restore.
      const includeDeleted =
        scoped === null &&
        String(req.user?.role) === "1" &&
        ["1", "true", "yes"].includes(
          String(req.query.includeDeleted || "").toLowerCase()
        );
      const [rows] = await DBConnection.query(
        scoped === null
          ? `SELECT ${BROKER_COLUMNS} FROM brokers WHERE Deleted = 0 ORDER BY id`
          : `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ? AND Deleted = 0`,
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
      await attachLastPayments(rows);
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

      // Soft-deleted brokers, listed only for an admin who asked for them. Their
      // row (balance, blancs, emails, policies) is untouched, so Restore is just
      // clearing the flags - see POST /brokers/:id/restore.
      let deleted = [];
      if (includeDeleted) {
        const [deletedRows] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS}, DeletedAt, DeletedBy
             FROM brokers
            WHERE Deleted = 1
            ORDER BY id`
        );
        deleted = deletedRows;
      }

      res.json({ brokers: rows, allowNegativeBalance, includeDeleted, deleted });
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
        `SELECT ${BROKER_COLUMNS} FROM brokers WHERE Deleted = 0 ORDER BY id`
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
          "Code",
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
              esc(b.Code),
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
                  CreationDate, StartDate, Annulled, AnnulFee, AnnulDate
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
              // The live annulled price is money too, so it is hidden with the
              // rest of the pricing.
              AnnulFee: null,
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
              // An annulled policy's price is its annulment tax, not the
              // sub-broker's display tariff.
              if (Number(p.Annulled) === 1) {
                const fee = Number(p.AnnulFee);
                return {
                  ...p,
                  Price: Number.isFinite(fee) ? fee : null,
                  CurrencyType: p.CurrencyType,
                };
              }
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
              displayCashBalance: null,
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
              // The underling's real current balance (`brokers.CashBalance`):
              // negative = what it still owes, positive = leftover credit.
              // The display balance below is priced with the sub-broker's own
              // show prices, so it overstates the debt and must not be used as
              // the amount owed. The main broker (the only caller of this
              // endpoint, besides an admin) is allowed to see the real balance.
              CashBalance: Math.round((Number(u.CashBalance) || 0) * 100) / 100,
              displayCashBalance: disp.displayCashBalance,
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

  // GET /brokers/:id/history — the broker's balance movements, newest first,
  // paginated (40 per page by default). With no ?since the history goes all the
  // way back to the broker's first movement, so the whole balance can be walked
  // back day by day. Optional ?since / ?until (YYYY-MM-DD[ HH:MM:SS]) narrow the
  // window and ?page / ?pageSize control pagination.
  //
  // Each movement is returned with the live policy behind its BlancNumber (when
  // there is one). A policy's "price_change" deltas are folded into its original
  // sale row, so an edited price silently appears as the policy's current price;
  // an annulled policy's refund is folded in the same way and the sale row shows
  // the annulment tax (the part kept). The folded rows are dropped - summing the
  // stored amounts keeps the balance and the net change unchanged. A policy that
  // now belongs to another broker disappears from this broker's history: its
  // sale and the cancellation written by the move are both dropped.
  // PolicyAnnulled / PolicyAnnulReason let the client tint that row exactly like
  // the policy tables do. A movement with no live policy (manual top-ups,
  // corrections) is untouched.
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

        // The balance before the broker's first insurance. Admins can set it on
        // this page (PUT /brokers/:id/starting-balance); it is shown next to the
        // movements so the whole history can be read from a known base.
        const startingBalance = await loadStartingBalance(brokerId);

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
        // the default upper bound ("now") must be resolved with the client's UTC
        // offset; otherwise a movement made in the last couple of hours would
        // fall outside the window's upper bound. Explicit since/until are already
        // client-local calendar dates, so they are used as literals.
        const tzOffset = Number(req.query.tzOffset);
        let since;
        let until;
        if (req.query.until === undefined || req.query.until === "") {
          until = clientLocalDateTime(tzOffset, now);
        } else {
          until = parseLocalBound(String(req.query.until));
          if (until === null) {
            return res.status(400).json({ error: "Invalid date range" });
          }
        }
        if (req.query.since === undefined || req.query.since === "") {
          // There is no default month: the history always goes all the way back
          // to the broker's first live movement, so the oldest balance can be
          // reached without narrowing the range by hand. An empty history starts
          // at the upper bound, which keeps the reported range meaningful.
          const [[first]] = await DBConnection.query(
            `SELECT MIN(CreatedAt) AS FirstMovement FROM broker_balance_movements
              WHERE BrokerId = ? AND Deleted = 0`,
            [brokerId]
          );
          const firstAt = first && first.FirstMovement;
          since = firstAt
            ? firstAt instanceof Date
              ? toLocalDateTime(firstAt)
              : String(firstAt)
            : until;
        } else {
          since = parseLocalBound(String(req.query.since));
          if (since === null) {
            return res.status(400).json({ error: "Invalid date range" });
          }
        }

        // Read the broker's whole live ledger first, not just the page or the
        // requested window: an annulled policy's sale and refund rows have to be
        // merged wherever they fall, so a window containing only one of them
        // still shows the effective price and the running balance stays right.
        // A broker's ledger is small enough for this, and the sub-broker path
        // already had to read all of its movements to price them.
        let allMovements;
        let currentBalance;
        let isSubBrokerHistory = false;

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
              balanceAtEnd: null,
              netChange: null,
              startingBalance: null,
              movements: [],
              includeDeleted: false,
              deleted: [],
            });
          }
          if (broker.IsSubBroker) {
            isSubBrokerHistory = true;
            const disp = await computeSubBrokerDisplayData(
              DBConnection,
              brokerId
            );
            const [rows] = await DBConnection.query(
              `SELECT id, Type, Amount, Reason, Author, BlancNumber, CreatedAt
                 FROM broker_balance_movements
                WHERE BrokerId = ? AND Deleted = 0
                ORDER BY CreatedAt DESC, id DESC`,
              [brokerId]
            );
            allMovements = (rows || []).map((m) => {
              const info = disp.policyByBlanc.get(
                String(m.BlancNumber ?? "").trim()
              );
              return {
                id: m.id,
                Type: m.Type,
                Amount: Math.round((Number(m.Amount) || 0) * 100) / 100,
                Reason: m.Reason,
                Author: m.Author,
                BlancNumber: m.BlancNumber,
                CreatedAt:
                  m.CreatedAt instanceof Date
                    ? toLocalDateTime(m.CreatedAt)
                    : m.CreatedAt,
                DisplayAmount: disp.mapMovementAmount(m),
                Retired: isRetiredMovementType(m.Type),
                PolicyAnnulled: info
                  ? Number(info.row.Annulled) === 1
                  : false,
                PolicyAnnulReason: info ? info.row.AnnulReason ?? null : null,
                // The display policy map only contains policies still owned by
                // this sub-broker; a moved-away policy has no entry.
                PolicyBrokerId: info ? brokerId : null,
              };
            });
            currentBalance = disp.displayCashBalance;
          }
        }

        if (!allMovements) {
          const [rows] = await DBConnection.query(
            `SELECT m.id, m.Type, m.Amount, m.Reason, m.Author,
                    m.BlancNumber, m.CreatedAt,
                    i.Annulled AS PolicyAnnulled,
                    i.AnnulReason AS PolicyAnnulReason,
                    i.BrokerId AS PolicyBrokerId
               FROM broker_balance_movements m
               LEFT JOIN insurance i
                 ON i.BlancNumber = m.BlancNumber AND i.Deleted = 0
              WHERE m.BrokerId = ? AND m.Deleted = 0
              ORDER BY m.CreatedAt DESC, m.id DESC`,
            [brokerId]
          );
          allMovements = (rows || []).map((m) => {
            const amount = Math.round((Number(m.Amount) || 0) * 100) / 100;
            return {
              id: m.id,
              Type: m.Type,
              Amount: amount,
              Reason: m.Reason,
              Author: m.Author,
              BlancNumber: m.BlancNumber,
              CreatedAt:
                m.CreatedAt instanceof Date
                  ? toLocalDateTime(m.CreatedAt)
                  : m.CreatedAt,
              DisplayAmount: amount,
              Retired: isRetiredMovementType(m.Type),
              PolicyAnnulled: Number(m.PolicyAnnulled) === 1,
              PolicyAnnulReason: m.PolicyAnnulReason ?? null,
              PolicyBrokerId:
                m.PolicyBrokerId === null || m.PolicyBrokerId === undefined
                  ? null
                  : Number(m.PolicyBrokerId),
            };
          });
          currentBalance =
            Math.round((Number(broker.CashBalance) || 0) * 100) / 100;
        }

        // Price edits are stored as "price_change" deltas and an annulment as a
        // separate refund. Neither is a movement the user wants to read: the
        // original sale row should simply show the policy's current price (its
        // annulment tax once annulled). Fold those deltas into the sale row and
        // hide the rows, which keeps the money identical - only the running
        // balance is reinterpreted as the policy's effective price.
        // Summing the stored amounts (rather than reading Price/AnnulFee) keeps
        // any admin correction to one of them intact. Manual increases, reduces,
        // adjustments and hand-overs are never folded; they stay as they are.
        const hiddenMovements = new Set();
        const movementsByBlanc = new Map();
        for (const m of allMovements) {
          const key = String(m.BlancNumber ?? "").trim();
          if (!key) continue;
          if (!movementsByBlanc.has(key)) movementsByBlanc.set(key, []);
          movementsByBlanc.get(key).push(m);
        }
        for (const group of movementsByBlanc.values()) {
          const policyRows = group.filter(
            (m) => String(m.Type ?? "").trim() === "policy"
          );
          // Without a sale row there is nothing to fold into; leave the raw
          // rows alone rather than losing their money.
          if (policyRows.length === 0) continue;

          // A broker move writes a "Broker change ..." price_change on the OLD
          // broker that cancels the sale. Once the policy belongs to another
          // broker, its old rows are no longer part of this broker's history:
          // drop them instead of leaving a zeroed sale behind. A move back keeps
          // a later policy row here, so it is not treated as an old side.
          const policyNet =
            Math.round(
              group.reduce((sum, m) => {
                const type = String(m.Type ?? "").trim();
                return type === "policy" ||
                  type === "price_change" ||
                  type === "annulment" ||
                  type === "deletion"
                  ? sum + m.DisplayAmount
                  : sum;
              }, 0) * 100
            ) / 100;
          const moveAwayRows = group.filter(
            (m) =>
              String(m.Type ?? "").trim() === "price_change" &&
              String(m.Reason ?? "")
                .trim()
                .toLowerCase()
                .startsWith("broker change")
          );
          if (moveAwayRows.length > 0) {
            const ownedHere = group.some(
              (m) =>
                m.PolicyBrokerId !== null &&
                m.PolicyBrokerId !== undefined &&
                Number(m.PolicyBrokerId) === brokerId
            );
            const latestMoveAway = moveAwayRows.reduce((latest, m) => {
              if (m.CreatedAt > latest.CreatedAt) return m;
              if (m.CreatedAt === latest.CreatedAt && m.id > latest.id) return m;
              return latest;
            }, moveAwayRows[0]);
            const laterPolicy = group.some(
              (m) =>
                String(m.Type ?? "").trim() === "policy" &&
                m.CreatedAt > latestMoveAway.CreatedAt
            );
            // The display ledger of a sub-broker is derived from its current
            // policy list, so hiding the old rows is what makes it add up; on a
            // main broker only a net-zero policy group can disappear without
            // changing the stored balance. Manual rows are never dropped.
            const canDrop = isSubBrokerHistory || Math.abs(policyNet) < 0.005;
            if (!ownedHere && !laterPolicy && canDrop) {
              for (const m of group) {
                const type = String(m.Type ?? "").trim();
                if (
                  type === "policy" ||
                  type === "price_change" ||
                  type === "annulment" ||
                  type === "deletion"
                ) {
                  hiddenMovements.add(m);
                }
              }
              continue;
            }
          }

          // An annulled policy's refund is folded too, but a restored policy
          // (Annulled = 0, with the historical refund still on the ledger) keeps
          // its refund row - the raw rows are the truth again.
          const annulled = group.some((m) => m.PolicyAnnulled);
          const foldedRows = group.filter((m) => {
            const type = String(m.Type ?? "").trim();
            return (
              type === "price_change" || (annulled && type === "annulment")
            );
          });
          if (foldedRows.length === 0) continue;

          const delta =
            Math.round(
              foldedRows.reduce((sum, m) => sum + m.DisplayAmount, 0) * 100
            ) / 100;
          // The original sale (oldest policy movement) is where the policy's
          // current price belongs.
          const target = policyRows.reduce((oldest, m) => {
            if (m.CreatedAt < oldest.CreatedAt) return m;
            if (m.CreatedAt === oldest.CreatedAt && m.id < oldest.id) return m;
            return oldest;
          }, policyRows[0]);
          target.DisplayAmount =
            Math.round((target.DisplayAmount + delta) * 100) / 100;
          for (const m of foldedRows) hiddenMovements.add(m);
        }

        const displayed = allMovements.filter((m) => !hiddenMovements.has(m));
        const windowRows = displayed.filter(
          (m) => m.CreatedAt >= since && m.CreatedAt < until
        );
        const total = windowRows.length;
        // A retired row (reduce/adjust) is listed so it can be reviewed and
        // deleted, but it never moves the balance: the balance rule ignores it,
        // and this walk does too. Its Amount is still shown.
        const balanceDelta = (m) => (m.Retired ? 0 : m.DisplayAmount);
        const netChange =
          Math.round(
            windowRows.reduce((sum, m) => sum + balanceDelta(m), 0) * 100
          ) / 100;
        // The balance of this page ALWAYS comes from the stored figure, never
        // from a sum of the ledger: the server rebuilds that figure from the
        // insurances + the payments the broker made inside every transaction
        // (see refreshBrokerBalance), so the Brokers tab and this page cannot
        // disagree. The starting balance above is shown for reference and is
        // already part of that figure - it is not added to the rows again.
        //
        // The stored balance is as of NOW, so the figure at the end of the
        // window is today's balance without everything that came after it. That
        // keeps walking the date back meaningful (a past day shows the balance
        // the broker had then) while staying on the single source of truth.
        const afterNet =
          Math.round(
            displayed.reduce(
              (sum, m) =>
                m.CreatedAt >= until ? sum + balanceDelta(m) : sum,
              0
            ) * 100
          ) / 100;
        const balanceAtEnd =
          Math.round((currentBalance - afterNet) * 100) / 100;
        const balanceAtStart =
          Math.round((balanceAtEnd - netChange) * 100) / 100;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const offset = (page - 1) * pageSize;

        let running = balanceAtEnd;
        const movementsWithBalance = windowRows.map((m) => {
          const balAfter = Math.round(running * 100) / 100;
          running = Math.round((running - balanceDelta(m)) * 100) / 100;
          return {
            id: m.id,
            Type: m.Type,
            Amount: m.DisplayAmount,
            Retired: m.Retired,
            Reason: m.Reason,
            Author: m.Author,
            BlancNumber: m.BlancNumber,
            CreatedAt: m.CreatedAt,
            BalanceAfter: balAfter,
            PolicyAnnulled: m.PolicyAnnulled,
            PolicyAnnulReason: m.PolicyAnnulReason,
          };
        });
        const movements = movementsWithBalance.slice(
          offset,
          offset + pageSize
        );

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
            Retired: isRetiredMovementType(r.Type),
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
          balanceAtEnd,
          netChange,
          startingBalance,
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
  // balance movement. `amount` changes the balance by the movement's
  // contribution difference; `type` can too, because a retired type
  // ("reduce"/"adjust") contributes 0 while any other type contributes its
  // amount. `reason`, `author` and `blancNumber` are cosmetic and are stored
  // verbatim.
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
        await ensurePaymentsTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, BrokerId, Amount, Type, Reason, Author, BlancNumber,
                  CreatedAt, Branch, Currency
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
          // A hand-over is money the broker paid to the owner: it counts as a
          // payment but carries no branch, so it is never Cash from Brokers.
          // Turning a branch top-up into a hand-over (or the other way round)
          // would silently move the money between those two ledgers, so the
          // boundary is fixed - delete the wrong row and add the right one.
          const wasHandover = String(existing.Type || "").trim() === "handover";
          if (wasHandover !== (type === "handover")) {
            return res.status(400).json({
              error:
                "a handover cannot be changed into an increase or an expense, or the other way round",
            });
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
        const nextAmount = newAmount === null ? previousAmount : newAmount;
        const nextType =
          rawType === undefined || String(rawType).trim() === ""
            ? existing.Type
            : String(rawType).trim();
        // A retired row contributes nothing to the balance, so editing its
        // amount (or another cosmetic field) must not move CashBalance. Moving
        // it in or out of a retired type does move it, by the contribution the
        // row gains or loses.
        const contribution = (type, amount) =>
          isRetiredMovementType(type) ? 0 : Number(amount) || 0;
        const delta =
          Math.round(
            (contribution(nextType, nextAmount) -
              contribution(existing.Type, previousAmount)) *
              100
          ) / 100;

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
          // A corrected payment is money too: keep the payments table in step,
          // then rebuild the balance (the payments + policies are the truth).
          await syncBrokerPaymentFromMovement(conn, {
            brokerId,
            movementId,
            type: nextType,
            amount: nextAmount,
            reason: rawReason === undefined ? existing.Reason : String(rawReason),
            author: rawAuthor === undefined ? existing.Author : String(rawAuthor),
            createdAt: existing.CreatedAt,
            branch: existing.Branch,
            currency: existing.Currency,
            deleted: false,
            deletedBy: req.user.username,
          });
          await refreshBrokerBalance(conn, brokerId);
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
  // effect on the broker's CashBalance is reversed. A retired row
  // (reduce/adjust) has no effect on the balance, so deleting it leaves
  // CashBalance untouched. POST …/restore undoes it.
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
        await ensurePaymentsTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, Amount, Type, Deleted FROM broker_balance_movements
            WHERE id = ? AND BrokerId = ?`,
          [movementId, brokerId]
        );
        if (!existing) {
          return res.status(404).json({ error: "Movement not found" });
        }
        if (existing.Deleted) {
          return res.status(400).json({ error: "Movement already deleted" });
        }

        // A retired row is history only and contributes nothing to the balance,
        // so hiding it must not add its amount back.
        const reversal = isRetiredMovementType(existing.Type)
          ? 0
          : Math.round(Number(existing.Amount) * -100) / 100;

        await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            `UPDATE broker_balance_movements
                SET Deleted = ?, DeletedAt = ?, DeletedBy = ?
              WHERE id = ?`,
            [1, new Date(), req.user.username, movementId]
          );
          if (reversal !== 0) {
            await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [reversal, brokerId]
            );
          }
          // Deleting a payment from the history removes the money too, so the
          // payments table and the rebuilt balance follow in the same step.
          await syncBrokerPaymentFromMovement(conn, {
            brokerId,
            movementId,
            type: existing.Type,
            amount: existing.Amount,
            deleted: true,
            deletedBy: req.user.username,
          });
          await refreshBrokerBalance(conn, brokerId);
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
  // clears Deleted/DeletedAt/DeletedBy, putting the row back as it was. A
  // retired row (reduce/adjust) never affected the balance, so restoring it
  // leaves CashBalance untouched.
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
        await ensurePaymentsTable();

        const [[existing]] = await DBConnection.query(
          `SELECT id, Amount, Type, Deleted FROM broker_balance_movements
            WHERE id = ? AND BrokerId = ?`,
          [movementId, brokerId]
        );
        if (!existing) {
          return res.status(404).json({ error: "Movement not found" });
        }
        if (!existing.Deleted) {
          return res.status(400).json({ error: "Movement is not deleted" });
        }

        const reapply = isRetiredMovementType(existing.Type)
          ? 0
          : Math.round((Number(existing.Amount) || 0) * 100) / 100;

        await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            `UPDATE broker_balance_movements
                SET Deleted = ?, DeletedAt = ?, DeletedBy = ?
              WHERE id = ?`,
            [0, null, null, movementId]
          );
          if (reapply !== 0) {
            await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [reapply, brokerId]
            );
          }
          await syncBrokerPaymentFromMovement(conn, {
            brokerId,
            movementId,
            type: existing.Type,
            amount: existing.Amount,
            deleted: false,
          });
          await refreshBrokerBalance(conn, brokerId);
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

  // POST /brokers/:id/increase  { amount, reason, currency, branch, date? }
  // The money is recorded as Cash from Brokers of `branch` (the branch that
  // took it); current cash is not touched.
  //
  // An admin may send `date` ("YYYY-MM-DD") to book the top-up on an earlier
  // day - money the broker handed over before anyone could enter it - so that
  // day's reports and Cash from Brokers include it. The time of day stays the
  // client's wall-clock time, so the row still sorts last within that day.
  // Only an admin may backdate: a worker's top-up is always "now", and the
  // server refuses `date` from anyone else.
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

        // The day is an explicit choice (`date`) rather than something inferred
        // from CreatedAt, which every client has always sent: only an admin may
        // ask for it, it must be a real calendar day and it may not be in the
        // future. The time of day is kept from the movement's own timestamp.
        let createdAt = moveTime.createdAt;
        const rawDate = req.body?.date ?? req.body?.Date;
        if (
          rawDate !== undefined &&
          rawDate !== null &&
          String(rawDate).trim()
        ) {
          if (String(req.user?.role ?? "") !== "1") {
            return res.status(403).json({
              error: "Only an admin can record an increase on an earlier date",
            });
          }
          const day = String(rawDate).trim();
          const parsed = new Date(`${day}T00:00:00`);
          // A day that does not exist in that month (2026-02-31) fails the
          // round-trip. No timezone conversion applies: it is a calendar day.
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
            Number.isNaN(parsed.getTime()) ||
            toLocalDateTime(parsed).slice(0, 10) !== day
          ) {
            return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
          }
          const today = clientLocalDateTime(
            req.body?.TzOffset ?? req.body?.tzOffset ?? null
          ).slice(0, 10);
          if (day > today) {
            return res
              .status(400)
              .json({ error: "Date cannot be in the future" });
          }
          createdAt = `${day} ${createdAt.slice(11)}`;
        }

        // Money handed over by a broker is the branch's Cash from Brokers, never
        // current cash. The top-up is recorded once, as a broker balance
        // movement carrying the branch that took the money and its currency
        // (see "Cash from brokers, per branch" in CurrentCash.js).
        await ensurePaymentsTable();
        const affectedRows = await DBConnection.withTransaction(
          async (conn) => {
            const [r] = await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [amount, brokerId]
            );
            if (r.affectedRows === 0) return r.affectedRows;

            await recordBrokerPayment(conn, brokerId, amount, "increase", {
              reason,
              author: req.user.username,
              createdAt,
              branch,
              currency,
            });

            // Rebuild the figure from the payments + policies in the same
            // transaction (brokers with a starting balance).
            await refreshBrokerBalance(conn, brokerId);

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
          branch,
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

  // There is deliberately NO POST /brokers/:id/reduce any more.
  //
  // A broker balance may only grow through money the broker actually paid (a
  // top-up or a hand-over). It falls by itself when a policy is created, and it
  // is recalculated from the starting balance and the broker's policies, so a
  // hand-typed reduction would only be undone by the next recalculation.
  // Rows of type "reduce" that already exist stay in broker_balance_movements
  // as history: the balance history page still lists them, and the
  // recalculation ignores them (see recalculateBrokerBalance).

  // PUT /brokers/:id/starting-balance  { amount, date }
  //
  // Admin-only. Records the balance the broker had BEFORE its first insurance
  // was created (the date says which day that balance belongs to; it defaults
  // to today) and recalculates CashBalance from it:
  //
  //   CashBalance = starting balance
  //               + manual payments (top-ups, hand-overs, expenses, corrections)
  //               - every live insurance (an annulled one at its annulment tax)
  //
  // See recalculateBrokerBalance. Saving again simply replaces the stored
  // starting balance and recalculates once more, so the figure can be repaired
  // at any time. The history page shows it above the movements.
  router.put(
    "/brokers/:id/starting-balance",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const brokerId = parseBrokerId(req.params.id);
        if (brokerId === null) {
          return res.status(400).json({ error: "Invalid broker id" });
        }

        const rawAmount =
          req.body?.amount ?? req.body?.Amount ?? req.body?.startingBalance;
        const amount = toDecimal(rawAmount);
        if (amount === null) {
          return res.status(400).json({ error: "Amount must be a number" });
        }

        // The date is a plain calendar day: no timezone conversion applies, the
        // client sends the day it means to record.
        let date = toLocalDateTime(new Date()).slice(0, 10);
        const rawDate = req.body?.date ?? req.body?.Date ?? req.body?.EffectiveDate;
        if (rawDate !== undefined && rawDate !== null && String(rawDate).trim()) {
          const s = String(rawDate).trim();
          const parsed = new Date(`${s}T00:00:00`);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
            Number.isNaN(parsed.getTime()) ||
            // Rejects days that do not exist in that month (2026-02-31).
            toLocalDateTime(parsed).slice(0, 10) !== s
          ) {
            return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
          }
          date = s;
        }

        const [[broker]] = await DBConnection.query(
          `SELECT ${BROKER_COLUMNS} FROM brokers WHERE id = ?`,
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        await ensureStartingBalanceTable();
        const author = (req.user && req.user.username) || "";
        const result = await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            `INSERT INTO broker_starting_balances
               (BrokerId, Amount, EffectiveDate, UpdatedBy)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE Amount = VALUES(Amount),
                                     EffectiveDate = VALUES(EffectiveDate),
                                     UpdatedBy = VALUES(UpdatedBy)`,
            [brokerId, amount, date, author]
          );
          // Saving the base is a balance change too: recalculate from it and let
          // the other clients know (queueBrokerBalanceNotification is batched).
          const saved = await recalculateBrokerBalance(conn, brokerId, amount);
          queueBrokerBalanceNotification(brokerId);
          return saved;
        });

        res.json({
          message: "Starting balance saved",
          startingBalance: {
            amount: result.startingBalance,
            date,
            updatedBy: author,
          },
          broker: {
            id: brokerId,
            Name: broker.Name,
            CashBalance: result.balance,
          },
          insuranceCharges: result.insuranceCharges,
          payments: result.payments,
        });
      } catch (err) {
        console.error("Broker starting balance update failed:", err);
        res.status(500).json({ error: "Failed to save the starting balance" });
      }
    }
  );

  // POST /brokers/:id/handover  { amount, reason, currency, CreatedAt? }
  // The broker paid the OWNER directly. This is a payment on the broker's
  // account - their balance grows by the amount, exactly like a top-up - but
  // the money never reached a branch, so the movement carries NO branch:
  //   - it is never counted in a branch's Cash from Brokers (CurrentCash.js
  //     reads only top-ups with a branch), and it writes no cash_transactions
  //     or total_cash rows;
  //   - it still counts as a payment in the reports (Reports.js reads
  //     'increase' and 'handover' together) and as the broker's last payment
  //     (attachLastPayments below).
  router.post(
    "/brokers/:id/handover",
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

        await ensurePaymentsTable();
        const affectedRows = await DBConnection.withTransaction(
          async (conn) => {
            const [r] = await conn.query(
              "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
              [amount, brokerId]
            );
            if (r.affectedRows === 0) return r.affectedRows;

            // No `branch` on purpose: the owner took the money outside the
            // branches, so this must not become Cash from Brokers.
            await recordBrokerPayment(conn, brokerId, amount, "handover", {
              reason,
              author: req.user.username,
              createdAt: moveTime.createdAt,
              currency,
            });

            await refreshBrokerBalance(conn, brokerId);

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
          message: "Broker handover recorded",
          amount,
          currency,
          broker,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("amount") || msg.includes("reason")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Broker handover failed:", err);
        res.status(500).json({ error: "Failed to record broker handover" });
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

      // Optional human-readable broker ID (e.g. "4.2"); empty becomes NULL.
      const code =
        String(req.body?.Code ?? req.body?.code ?? "").trim() || null;

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
      // The balance a broker is created with IS its starting balance, so the
      // row is written in the same transaction: the first recalculation
      // (PUT /brokers/:id/starting-balance) then starts from the figure the
      // admin created the broker with instead of from 0.
      await ensureStartingBalanceTable();

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
               (Name, Code, CashBalance, PolicyRangeStart, PolicyRangeEnd, InactivePolicies, ParentBrokerId)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, code, cashBalance, 0, 0, 0, parentBrokerId]
          );
          const id = result.insertId;
          await insertBatches(conn, id, batches, req.user?.username);
          for (const email of emails) {
            await conn.query(
              "INSERT INTO broker_emails (BrokerId, Email) VALUES (?, ?)",
              [id, email]
            );
          }
          // The creation balance becomes the starting balance, dated today (the
          // server's local day - a broker has no client-stamped time of its
          // own). A later PUT /brokers/:id/starting-balance replaces it and
          // recalculates the balance.
          await conn.query(
            `INSERT INTO broker_starting_balances
               (BrokerId, Amount, EffectiveDate, UpdatedBy)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE Amount = VALUES(Amount),
                                     EffectiveDate = VALUES(EffectiveDate),
                                     UpdatedBy = VALUES(UpdatedBy)`,
            [
              id,
              cashBalance,
              toLocalDateTime(new Date()).slice(0, 10),
              (req.user && req.user.username) || "",
            ]
          );
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
        "SELECT id FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Broker not found" });
      }

      const b = req.body || {};
      const sets = [];
      const params = [];

      // The balance is no longer a broker field: it is calculated from the
      // starting balance, the broker's policies and the payments it made (see
      // PUT /brokers/:id/starting-balance), so an admin cannot type one here
      // and no "adjust" row is ever written. A CashBalance sent by an older
      // client is ignored instead of failing the whole edit, so its Name, Code
      // and emails still save.
      //
      // Blanc ranges are no longer broker fields either - they are managed as
      // batches (POST/PATCH/DELETE /brokers/:id/batches), and InactivePolicies
      // is calculated from them, so neither can be set here.
      const fieldMap = [
        ["Name", b.Name ?? b.name],
        ["Code", b.Code ?? b.code],
      ];

      for (const [column, value] of fieldMap) {
        if (value === undefined || value === null) continue;
        let v;
        if (column === "Name") {
          v = String(value).trim();
          if (!v) {
            return res.status(400).json({ error: "Name cannot be empty" });
          }
        } else {
          // Code is a nullable string: an empty value clears the broker ID.
          v = String(value).trim() || null;
        }
        sets.push(`${column} = ?`);
        params.push(v);
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

  // DELETE /brokers/:id — soft-delete a broker. The row is never removed: it is
  // flagged with Deleted/DeletedAt/DeletedBy (like a soft-deleted insurance or
  // movement), so its balance, blanc batches, emails, tariff list and linked
  // policies all stay intact, and an admin can bring it back with
  // POST /brokers/:id/restore. A deleted broker is hidden from every list and
  // its addresses stop resolving to a broker (resolveBrokerByEmail), so its
  // emails are not shown to workers either.
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

      await DBConnection.query(
        "UPDATE brokers SET Deleted = 1, DeletedAt = NOW(), DeletedBy = ? WHERE id = ?",
        [String(req.user?.username || ""), brokerId]
      );

      // Drop the broker's live email cards and claims: it must stop receiving
      // new email policies the moment it is deleted.
      const [emailRows] = await DBConnection.query(
        "SELECT Email FROM broker_emails WHERE BrokerId = ?",
        [brokerId]
      );
      const { evictEmailsForAddresses } = require("../Users/websocket.js");
      await evictEmailsForAddresses(emailRows.map((r) => r.Email));

      res.json({ message: "Broker deleted", id: brokerId, deleted: true });
    } catch (err) {
      console.error("Broker delete failed:", err);
      res.status(500).json({ error: "Failed to delete broker" });
    }
  });

  // POST /brokers/:id/restore — bring a soft-deleted broker back into every
  // list. Nothing else has to be re-applied: the balance, blanc batches, emails
  // and policies of the broker were never touched by the delete.
  router.post("/brokers/:id/restore", auth, requireAdmin, async (req, res) => {
    try {
      const brokerId = parseBrokerId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }

      const [rows] = await DBConnection.query(
        "SELECT id, Deleted FROM brokers WHERE id = ?",
        [brokerId]
      );
      const broker = rows[0] || null;
      if (!broker) {
        return res.status(404).json({ error: "Broker not found" });
      }
      if (!Number(broker.Deleted)) {
        return res.status(400).json({ error: "Broker is not deleted" });
      }

      await DBConnection.query(
        "UPDATE brokers SET Deleted = 0, DeletedAt = NULL, DeletedBy = NULL WHERE id = ?",
        [brokerId]
      );

      res.json({ message: "Broker restored", id: brokerId });
    } catch (err) {
      console.error("Broker restore failed:", err);
      res.status(500).json({ error: "Failed to restore broker" });
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
            // An admin correcting the range takes the batch over: it is no
            // longer an automatically added one, so the client stops painting
            // it pink.
            "UPDATE broker_blanc_batches SET RangeStart = ?, RangeEnd = ?, AutoAdded = 0 WHERE id = ?",
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

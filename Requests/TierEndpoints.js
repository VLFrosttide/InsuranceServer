"use strict";
// Role-specific (tiered) protected endpoints.
//
// User roles in the database:
//   1 = admin
//   2 = worker
//   3 = client
//
// Every route below is protected by `requireAuth` and further restricted with
// `requireRole`, so a user can only reach endpoints matching their tier.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const {
  recordCashMovement,
  recordChannelMovement,
  movePolicyBranch,
  toDecimal,
} = require("./CurrentCash.js");
const { recordCardPayment, reduceCardBalance } = require("./CardPayments.js");
const {
  resolveBrokerByEmail,
  decreaseBrokerForInsurance,
  restoreBrokerForAnnulment,
  restoreBrokerForDeletion,
  adjustBrokerForPriceChange,
  getBrokerAllowNegativeBalance,
  salePricingFor,
  loadOwnBrokerTariffs,
  attachSubBrokerStatus,
  computePolicyTariffPrice,
} = require("./Brokers.js");
const { sendReply } = require("../Mail/SendReply.js");

/**
 * Resolve an insurance payment type from the received value.
 *
 * A boolean `true` (or the legacy strings "true"/"1"/"yes") maps to "Cash";
 * a boolean `false` maps to "Card". The literal strings "Cash"/"Card"/"Broker"
 * are also accepted (case-insensitive) so the PaymentType field can be
 * round-tripped.
 *
 * Payment types:
 *   Cash   - walk-in, paid into the cash drawer (current cash).
 *   Card   - walk-in, paid by card (card balance).
 *   Broker - email policy, paid ONLY from the broker's balance. Email policies
 *            can never be Cash or Card, and walk-ins can never be Broker.
 *
 * @param {unknown} value
 * @returns {"Cash"|"Card"|"Broker"}
 */
function resolvePaymentType(value) {
  if (typeof value === "boolean") return value ? "Cash" : "Card";
  if (value === undefined || value === null || value === "") return "Card";
  const s = String(value).trim();
  const lower = s.toLowerCase();
  if (lower === "cash") return "Cash";
  if (lower === "card") return "Card";
  if (lower === "broker") return "Broker";
  return lower === "true" || lower === "1" || lower === "yes" ? "Cash" : "Card";
}

/**
 * Whether a stored policy is linked to a broker (i.e. it was created from a
 * broker's email).
 */
function isBrokerLinked(insurance) {
  return (
    insurance.BrokerId !== null &&
    insurance.BrokerId !== undefined &&
    insurance.BrokerId !== ""
  );
}

/**
 * The channel a stored policy's money actually went through. Before the
 * "Broker" payment type existed, email policies were stored as "Cash" while
 * being funded by the broker's balance, so such legacy rows are treated as
 * "Broker" too.
 *
 * @returns {"Cash"|"Card"|"Broker"}
 */
function effectivePayment(insurance) {
  // Any broker-linked row was funded by the broker's balance, whatever payment
  // type a legacy row was stored with (Cash or Card before "Broker" existed).
  if (isBrokerLinked(insurance)) return "Broker";
  return resolvePaymentType(insurance.PaymentType);
}

/**
 * Move a policy's money through the ledger that matches its payment type.
 * Runs inside the caller's transaction.
 *
 *   Broker -> Broker part of Total cash only (never current cash; the broker's
 *             own balance is handled separately by Brokers.js).
 *   Cash   -> current cash (and, through it, Total cash).
 *   Card   -> the branch's card balance + Card part of Total cash.
 */
async function movePolicyMoney(conn, payment, type, m, createdAt) {
  const { branch, username, amount, reason, currency } = m;
  if (payment === "Broker") {
    return recordChannelMovement(
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      "Broker",
      createdAt
    );
  }
  if (payment === "Cash") {
    return recordCashMovement(
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      createdAt
    );
  }
  // The card balance is kept per branch: the policy's branch gets the money.
  if (type === "increase") {
    await recordCardPayment(conn, branch, username, amount, reason);
  } else {
    await reduceCardBalance(conn, branch, username, amount, reason);
  }
  return recordChannelMovement(
    conn,
    branch,
    username,
    type,
    amount,
    reason,
    currency,
    "Card",
    createdAt
  );
}

/**
 * Coerce a checkbox-like value (boolean, "true", "1", 1, "yes") to a boolean.
 */
function toFlag(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * Parse a human/duration value into an integer number of days.
 * Accepts "15", "15 дена", "3 месеца", "1 година", etc.
 */
function parseDurationDays(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const str = String(value).toLowerCase();
  const num = parseInt(str.replace(/[^0-9]/g, ""), 10);
  if (Number.isNaN(num)) return 0;
  if (str.includes("годин") || str.includes("year")) return num * 365;
  if (str.includes("месец") || str.includes("month")) return num * 30;
  return num; // days
}

// ---------------------------------------------------------------------------
// Annulment fees
// ---------------------------------------------------------------------------
// The fee is decided by whether the policy is already in effect when it is
// annulled (now has reached its start date): 1 if it has not started yet,
// 9 if it already has. Who pays it (broker or worker) is chosen in the form;
// "none" (no fault) charges no fee at all.
//
// The fee is in the policy's own currency and is deducted from the refund.
// ---------------------------------------------------------------------------

const ANNUL_PAYERS = ["broker", "worker", "none"];
const ANNUL_FEE_NOT_IN_EFFECT = 1;
const ANNUL_FEE_IN_EFFECT = 9;

/**
 * Parse a policy start date into the LOCAL midnight it begins at.
 *
 * Accepts a Date (mysql2 returns DATE columns as local-midnight Dates) or a
 * "YYYY-MM-DD" / "YYYY-MM-DD HH:MM:SS" / ISO string. Only the calendar day is
 * used: a policy is in effect for the whole of its starting day.
 *
 * @param {Date|string|null|undefined} value
 * @returns {Date|null}
 */
function parseStartDate(value) {
  if (value === undefined || value === null || value === "") return null;
  // Realm-safe Date check (instanceof fails for Dates from another context).
  if (Object.prototype.toString.call(value) === "[object Date]") {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Whether a policy is already in effect at `now`, i.e. `now` has reached its
 * start date. A policy without a usable start date is treated as in effect
 * (the higher fee), since there is nothing to prove it has not started.
 *
 * @param {{StartDate?: any}} insurance
 * @param {Date} now
 * @returns {boolean}
 */
function isPolicyInEffect(insurance, now) {
  const start = parseStartDate(insurance && insurance.StartDate);
  if (!start) return true;
  return now.getTime() >= start.getTime();
}

/**
 * The annulment fee for a policy at `now`. "none" (no fault) is always free;
 * otherwise the start date decides (1 not yet in effect, 9 already in effect).
 *
 * @param {{StartDate?: any}} insurance
 * @param {Date} now
 * @param {"broker"|"worker"|"none"} payer
 * @returns {{fee: number, inEffect: boolean}}
 */
function computeAnnulFee(insurance, now, payer) {
  const inEffect = isPolicyInEffect(insurance, now);
  if (payer === "none") return { fee: 0, inEffect };
  return {
    fee: inEffect ? ANNUL_FEE_IN_EFFECT : ANNUL_FEE_NOT_IN_EFFECT,
    inEffect,
  };
}

// Real-world UTC offsets range from UTC-12:00 to UTC+14:00.
const MIN_TZ_OFFSET_MINUTES = -12 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/**
 * Validate the creation time computed by the client: the worker's local
 * wall-clock time as a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS"). A "T"
 * separator is accepted as well. Impossible dates/times (2026-02-31, 25:00)
 * are rejected.
 *
 * @param {unknown} value
 * @returns {string|null} The normalised "YYYY-MM-DD HH:MM:SS", or null.
 */
function parseClientDateTime(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim()
  );
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== mo - 1 ||
    t.getUTCDate() !== d ||
    t.getUTCHours() !== h ||
    t.getUTCMinutes() !== mi ||
    t.getUTCSeconds() !== s
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}
module.exports.parseClientDateTime = parseClientDateTime;

/**
 * Fallback creation time for clients that do not send CreationDate yet: the
 * server clock shifted by the client's UTC offset in minutes (east positive,
 * e.g. +180 for UTC+3), as a MySQL DATETIME string. A missing/invalid offset
 * falls back to UTC. Never uses the database's NOW(), which runs in UTC on
 * the hosting.
 *
 * @param {unknown} offsetMinutes
 * @param {Date} [now]
 * @returns {string}
 */
function clientLocalDateTime(offsetMinutes, now = new Date()) {
  let offset = Number(offsetMinutes);
  if (
    !Number.isFinite(offset) ||
    offset < MIN_TZ_OFFSET_MINUTES ||
    offset > MAX_TZ_OFFSET_MINUTES
  ) {
    offset = 0;
  }
  const local = new Date(now.getTime() + Math.round(offset) * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(
      local.getUTCDate()
    )} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(
      local.getUTCSeconds()
    )}`
  );
}
module.exports.clientLocalDateTime = clientLocalDateTime;

/**
 * Resolve the client's local wall-clock time for a ledger entry a policy
 * operation (edit / annul / delete / restore) produces. The client sends
 * CreatedAt (its local "YYYY-MM-DD HH:MM:SS"); older clients fall back to the
 * server clock shifted by their TzOffset (UTC when that is missing too).
 *
 * Mirrors CurrentCash.resolveRequestCreatedAt, but lives here so TierEndpoints
 * needs no extra import and validates with the same datetime rules.
 *
 * @param {object} [body]
 * @returns {{createdAt: string}|{error: string}}
 */
function resolveMoveCreatedAt(body) {
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

// ---------------------------------------------------------------------------
// Broker name matching (script-insensitive)
// ---------------------------------------------------------------------------

// Bulgarian Cyrillic → Latin transliteration, so broker lookups are insensitive
// to the Cyrillic/Latin script difference. Lowercases first, then maps each
// Cyrillic letter to its Latin equivalent (Streamlined System for Bulgarian).
// Latin letters and everything else pass through unchanged, so a Latin query
// ("Lesovo") and a Cyrillic stored name ("ГКПП Лесово") normalise to the same
// Latin form ("lesovo" / "gkpp lesovo").
const BULGARIAN_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
};
function transliterateBulgarian(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[а-я]/g, (ch) => BULGARIAN_TO_LATIN[ch] || ch);
}
module.exports.transliterateBulgarian = transliterateBulgarian;

// Whether a stored broker name matches a query, ignoring case and script. The
// query's words must appear in order as substrings of the stored name (both
// normalised to Latin first), so:
//   - "Lesovo"        matches "ГКПП Лесово"
//   - "kap andreevo"  matches "ГКПП Капитан Андреево" ("kap" prefixes "kapitan")
//   - "Euro"          matches "Euroins"
function brokerNameMatches(storedBroker, query) {
  const haystack = transliterateBulgarian(storedBroker);
  const words = transliterateBulgarian(query).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  let from = 0;
  for (const word of words) {
    const idx = haystack.indexOf(word, from);
    if (idx === -1) return false;
    from = idx + word.length;
  }
  return true;
}
module.exports.brokerNameMatches = brokerNameMatches;

// ---------------------------------------------------------------------------
// Policy currency rules: TRY is restricted to Lesovo / Kap Andreevo Auto.
// ---------------------------------------------------------------------------
// Turkish lira is only valid for Auto policies issued at the two border
// crossings (Lesovo and Kap Andreevo). Every other vehicle type and every
// other branch is EUR only. These helpers enforce that rule on both policy
// creation and editing.
const TRY_BRANCH_QUERIES = ["lesovo", "kap andreevo"];
const AUTO_VEHICLE_NAMES = new Set([
  "auto", "automobile", "otomobil", "araba", "car", "avtomobil", "automobil",
  "kola", "leka kola",
]);

function isTryEligibleBranch(branch) {
  return TRY_BRANCH_QUERIES.some((q) => brokerNameMatches(branch, q));
}
module.exports.isTryEligibleBranch = isTryEligibleBranch;

function isAutoVehicle(otomobil) {
  const s = transliterateBulgarian(otomobil).replace(/\s+/g, " ").trim();
  return AUTO_VEHICLE_NAMES.has(s);
}
module.exports.isAutoVehicle = isAutoVehicle;

// Normalise an incoming currency code to "EUR" or "TRY". Anything unknown,
// empty (or the removed "USD" code) falls back to EUR so legacy callers and
// older records keep working.
function normalizePolicyCurrency(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  return s === "TRY" ? "TRY" : "EUR";
}
module.exports.normalizePolicyCurrency = normalizePolicyCurrency;

// Return a human-readable error when a policy's (branch, vehicle, currency)
// combination breaks the rule, or null when it is allowed.
function validatePolicyCurrency(branch, otomobil, currency) {
  if (currency !== "TRY") return null;
  if (isTryEligibleBranch(branch) && isAutoVehicle(otomobil)) return null;
  return "Turkish lira is only allowed for Auto policies at the Lesovo / Kap Andreevo border crossings";
}
module.exports.validatePolicyCurrency = validatePolicyCurrency;


/**
 * Create the tiered router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createTierRouter = function createTierRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);

  // ---------------------------------------------------------------------
  // Admin tier (role 1)
  // ---------------------------------------------------------------------
  router.get("/admin", auth, requireRole(1), (req, res) => {
    res.json({
      tier: "admin",
      message: "Welcome to the admin panel",
      user: req.user,
    });
  });

  router.get("/admin/users", auth, requireRole(1), async (req, res) => {
    try {
      const [users] = await DBConnection.query(
        `SELECT Username, Role, Balance, Status, BrokerId, Email, CreatedAt
         FROM users
         ORDER BY CreatedAt DESC, Username`
      );
      res.json({ users });
    } catch (err) {
      console.error("Admin users lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // PATCH /admin/users/:username — update an account's broker link (BrokerId),
  // status, role and/or balance. Admins use this from the Users panel's edit
  // dialog. Role changes follow the same rules as /promote: an admin's role
  // cannot be changed and no account can be set to admin.
  router.patch("/admin/users/:username", auth, requireRole(1), async (req, res) => {
    try {
      const username = String(req.params.username || "").trim();
      if (!username) {
        return res.status(400).json({ error: "Username is required" });
      }

      const [rows] = await DBConnection.query(
        "SELECT Username, Role FROM users WHERE Username = ?",
        [username]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      const existingRole = String(rows[0].Role);

      const b = req.body || {};
      const sets = [];
      const params = [];

      if (b.BrokerId !== undefined || b.brokerId !== undefined) {
        const raw = b.BrokerId ?? b.brokerId;
        let brokerId = null;
        if (raw !== null && raw !== "" && raw !== undefined) {
          brokerId = Number(raw);
          if (!Number.isInteger(brokerId) || brokerId <= 0) {
            return res
              .status(400)
              .json({ error: "BrokerId must be a positive integer or null" });
          }
          const [br] = await DBConnection.query(
            "SELECT id FROM brokers WHERE id = ?",
            [brokerId]
          );
          if (br.length === 0) {
            return res.status(404).json({ error: "Broker not found" });
          }
        }
        sets.push("BrokerId = ?");
        params.push(brokerId);
      }

      if (b.Status !== undefined || b.status !== undefined) {
        const status = String(b.Status ?? b.status).toLowerCase();
        if (status !== "active" && status !== "suspended") {
          return res
            .status(400)
            .json({ error: "Status must be 'active' or 'suspended'" });
        }
        sets.push("Status = ?");
        params.push(status);
      }

      if (b.role !== undefined || b.Role !== undefined) {
        const rawRole = b.role !== undefined ? b.role : b.Role;
        const role = Number(rawRole);
        if (!Number.isInteger(role) || ![1, 2, 3].includes(role)) {
          return res.status(400).json({ error: "role must be 1, 2 or 3" });
        }
        if (existingRole === "1" || role === 1) {
          return res.status(403).json({
            error: "Forbidden: cannot change the role of an admin",
          });
        }
        sets.push("Role = ?");
        params.push(role);
      }

      if (b.balance !== undefined || b.Balance !== undefined) {
        const rawBalance = b.balance !== undefined ? b.balance : b.Balance;
        const balance = Number(rawBalance);
        if (!Number.isFinite(balance) || balance < 0) {
          return res
            .status(400)
            .json({ error: "balance must be a non-negative number" });
        }
        sets.push("Balance = ?");
        params.push(balance);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      params.push(username);
      await DBConnection.query(
        `UPDATE users SET ${sets.join(", ")} WHERE Username = ?`,
        params
      );

      res.json({ message: "User updated", username });
    } catch (err) {
      console.error("Admin user update failed:", err);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // POST /admin/users/:username/approve — approve a pending self-registered
  // account by activating it and binding it to a broker. Both happen together:
  // a broker login is only usable once it has an active status AND a broker.
  router.post(
    "/admin/users/:username/approve",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const username = String(req.params.username || "").trim();
        if (!username) {
          return res.status(400).json({ error: "Username is required" });
        }

        const brokerId = Number(req.body?.brokerId ?? req.body?.BrokerId);
        if (!Number.isInteger(brokerId) || brokerId <= 0) {
          return res
            .status(400)
            .json({ error: "brokerId must be a positive integer" });
        }

        const [rows] = await DBConnection.query(
          "SELECT Username FROM users WHERE Username = ?",
          [username]
        );
        if (rows.length === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        const [brokers] = await DBConnection.query(
          "SELECT id FROM brokers WHERE id = ?",
          [brokerId]
        );
        if (brokers.length === 0) {
          return res.status(404).json({ error: "Broker not found" });
        }

        await DBConnection.withTransaction(async (conn) => {
          await conn.query(
            "UPDATE users SET Status = 'active', BrokerId = ? WHERE Username = ?",
            [brokerId, username]
          );
          await conn.query("DELETE FROM tokens WHERE Username = ?", [username]);
        });

        res.json({ message: "User approved", username, brokerId });
      } catch (err) {
        console.error("Admin approve failed:", err);
        res.status(500).json({ error: "Failed to approve user" });
      }
    }
  );


  router.get("/admin/stats", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN Role = 1 THEN 1 ELSE 0 END), 0) AS admins,
           COALESCE(SUM(CASE WHEN Role = 2 THEN 1 ELSE 0 END), 0) AS workers,
           COALESCE(SUM(CASE WHEN Role = 3 THEN 1 ELSE 0 END), 0) AS clients
         FROM users`
      );
      res.json({ stats: rows[0] || {} });
    } catch (err) {
      console.error("Admin stats lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // Deleted insurances are soft-deleted (Deleted = 1): they stay in the
  // database for record-keeping, but are hidden from every normal list so
  // they no longer get parsed (e.g. by the daily-report reconciliation).
  // Pass ?includeDeleted=1 to also see them (e.g. for an audit view).
  router.get("/admin/insurances", auth, requireRole(1), async (req, res) => {
    try {
      const includeDeleted = ["1", "true", "yes"].includes(
        String(req.query.includeDeleted || "").toLowerCase()
      );
      const [rows] = await DBConnection.query(
        includeDeleted
          ? "SELECT * FROM insurance"
          : "SELECT * FROM insurance WHERE Deleted = 0"
      );
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Admin insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  // POST /admin/insurances — create an insurance from the admin panel.
  // Like POST /worker/insurances, but:
  //   - admin-only (role 1);
  //   - the creation date can be back-dated (an "older date"), so a policy that
  //     was actually sold earlier can be entered after the fact. The insurance
  //     row and its broker-balance movement are both stamped with that date;
  //   - the broker is chosen explicitly via BrokerId (instead of being resolved
  //     from an email sender), and that broker's balance is charged. With no
  //     BrokerId the policy is a normal walk-in (cash or card);
  //   - no return email / attachments are involved.
  router.post("/admin/insurances", auth, requireRole(1), async (req, res) => {
    try {
      const b = req.body || {};
      const policyNumber = b.PolicyNumber ?? b.policyNumber ?? "";
      const blancNumber = b.BlancNumber ?? b.blancNumber ?? "";
      const carNumber = b.CarNumber ?? b.carNumber ?? "";
      let price = String(b.Price ?? b.price ?? "");
      const currencyType = normalizePolicyCurrency(
        b.CurrencyType ?? b.currencyType ?? ""
      );
      const duration = parseDurationDays(b.Duration ?? b.duration ?? 0);
      const branch = b.Branch ?? b.branch ?? "";
      const otomobil = b.Otomobil ?? b.otomobil ?? "";
      const currencyError = validatePolicyCurrency(branch, otomobil, currencyType);
      if (currencyError) {
        return res.status(400).json({ error: currencyError });
      }

      // Optional explicit broker assignment. When set, the policy is paid from
      // that broker's balance (PaymentType = "Broker"); otherwise it is a
      // walk-in paid in cash or by card.
      const brokerIdRaw = b.BrokerId ?? b.brokerId ?? null;
      let brokerId = null;
      if (
        brokerIdRaw !== null &&
        brokerIdRaw !== undefined &&
        String(brokerIdRaw).trim() !== ""
      ) {
        brokerId = Number(brokerIdRaw);
        if (!Number.isInteger(brokerId) || brokerId <= 0) {
          return res
            .status(400)
            .json({ error: "BrokerId must be a positive integer or null" });
        }
      }

      const requestedPayment = resolvePaymentType(
        b.Cash ?? b.cash ?? b.PaymentType ?? b.paymentType
      );
      const paymentType = brokerId !== null ? "Broker" : requestedPayment;

      // The non-Turk tax (+5, already included in Price) only applies to
      // walk-ins: a broker-balance policy carrying it is rejected.
      const nonTurk = toFlag(b.NonTurk ?? b.nonTurk);
      if (brokerId !== null && nonTurk) {
        return res.status(400).json({
          error: "The non-Turk tax only applies to walk-in policies",
        });
      }
      const cardFee = false;

      if (!String(blancNumber).trim()) {
        return res.status(400).json({ error: "BlancNumber is required" });
      }
      if (!String(carNumber).trim()) {
        return res.status(400).json({ error: "CarNumber is required" });
      }
      if (!String(policyNumber).trim()) {
        return res.status(400).json({ error: "PolicyNumber is required" });
      }

      // The creation time is the admin's local wall-clock time; it may be an
      // older date when entering a policy that was sold earlier.
      const sentCreationDate = b.CreationDate ?? b.creationDate;
      let creationDate;
      if (
        sentCreationDate !== undefined &&
        sentCreationDate !== null &&
        sentCreationDate !== ""
      ) {
        creationDate = parseClientDateTime(sentCreationDate);
        if (!creationDate) {
          return res.status(400).json({
            error: "CreationDate must be in YYYY-MM-DD HH:MM:SS format",
          });
        }
      } else {
        creationDate = clientLocalDateTime(b.TzOffset ?? b.tzOffset ?? null);
      }

      let startDate = b.StartDate ?? b.startDate ?? null;
      if (startDate === "") startDate = null;

      // Resolve the assigned broker and, when the client did not send a price,
      // compute it from the broker's tariffs (mirrors email-policy creation,
      // including the sub-broker main-broker sale price).
      let brokerName = String(branch);
      if (brokerId !== null) {
        const [[broker]] = await DBConnection.query(
          "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
          [brokerId]
        );
        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }
        brokerName = broker.Name;

        if (toDecimal(price) === null) {
          try {
            await attachSubBrokerStatus(DBConnection, [broker]);
            const saleEff = await salePricingFor(DBConnection, brokerId);
            const mainTariffPrice = computePolicyTariffPrice(
              {
                Otomobil: otomobil,
                Duration: duration,
                NonTurk: 0,
                CardFee: 0,
                PaymentType: "Broker",
              },
              saleEff.pricing
            );
            if (mainTariffPrice !== null) price = String(mainTariffPrice);
          } catch {
            // Ignore in minimal test mocks.
          }
        }
      }

      const priceDecimal = toDecimal(price);

      await DBConnection.withTransaction(async (conn) => {
        await conn.query(
          `INSERT INTO insurance
              (Author, CreationDate, PolicyNumber, BlancNumber, CarNumber, Price,
               CurrencyType, Duration, Broker, Branch, Otomobil, PaymentType,
               StartDate, BrokerId, NonTurk, CardFee)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.username,
            creationDate,
            policyNumber,
            blancNumber,
            String(carNumber).trim(),
            price,
            currencyType,
            duration,
            brokerName,
            branch,
            otomobil,
            paymentType,
            startDate,
            brokerId,
            nonTurk ? 1 : 0,
            cardFee ? 1 : 0,
          ]
        );

        if (priceDecimal !== null && priceDecimal > 0) {
          await movePolicyMoney(
            conn,
            paymentType,
            "increase",
            {
              branch,
              username: req.user.username,
              amount: priceDecimal,
              reason: blancNumber,
              currency: currencyType,
            },
            creationDate
          );
        }

        if (brokerId !== null) {
          await decreaseBrokerForInsurance(conn, brokerId, price, {
            reason: blancNumber,
            author: req.user.username,
            blancNumber,
            createdAt: creationDate,
          });
        }
      });

      res.status(201).json({
        message: "Insurance created",
        blancNumber,
        author: req.user.username,
      });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: "Insurance with this BlancNumber already exists" });
      }
      console.error("Admin insurance create failed:", err);
      res.status(500).json({ error: "Failed to create insurance" });
    }
  });


  // Admin worker account management: suspend, delete, and promote.
  //
  // - suspend: set users.Status = 'suspended' (blocked immediately by the auth
  //   middleware) and delete any live session tokens.
  // - delete: remove the account (and its sessions). Deleting the last admin
  //   is not allowed to avoid locking everyone out.
  // - promote: change a worker's (or client's) role to 2 (worker).
  //
  // Only admins (role 1) may use these. Actions against other admins are
  // disallowed so an admin cannot be silently removed or demoted.

  const ADMIN_USER_COLUMNS = "Username, Role, Balance, Status";

  function parseRole(value) {
    const n = Number(value);
    return Number.isInteger(n) && [1, 2, 3].includes(n) ? n : null;
  }

  async function fetchUser(res, username) {
    const [rows] = await DBConnection.query(
      `SELECT ${ADMIN_USER_COLUMNS} FROM users WHERE Username = ?`,
      [username]
    );
    return rows[0] || null;
  }

  router.post(
    "/admin/users/:username/suspend",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { username } = req.params;
        const user = await fetchUser(res, username);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        if (String(user.Role) === "1") {
          return res
            .status(403)
            .json({ error: "Forbidden: cannot suspend an admin" });
        }

        await DBConnection.query(
          "UPDATE users SET Status = 'suspended' WHERE Username = ?",
          [username]
        );
        // Immediately invalidate any live sessions.
        await DBConnection.query("DELETE FROM tokens WHERE Username = ?", [
          username,
        ]);

        const updated = await fetchUser(res, username);
        res.json({ message: "User suspended", user: updated });
      } catch (err) {
        console.error("Admin suspend failed:", err);
        res.status(500).json({ error: "Failed to suspend user" });
      }
    }
  );

  router.post(
    "/admin/users/:username/delete",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { username } = req.params;
        if (username === req.user.username) {
          return res
            .status(400)
            .json({ error: "Cannot delete your own account" });
        }

        const user = await fetchUser(res, username);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        if (String(user.Role) === "1") {
          return res
            .status(403)
            .json({ error: "Forbidden: cannot delete an admin" });
        }

        await DBConnection.withTransaction(async (conn) => {
          await conn.query("DELETE FROM tokens WHERE Username = ?", [username]);
          await conn.query("DELETE FROM users WHERE Username = ?", [username]);
        });

        res.json({ message: "User deleted", username });
      } catch (err) {
        console.error("Admin delete failed:", err);
        res.status(500).json({ error: "Failed to delete user" });
      }
    }
  );

  router.post(
    "/admin/users/:username/promote",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { username } = req.params;
        const role = parseRole(req.body?.role ?? 2);
        if (role === null) {
          return res.status(400).json({ error: "role must be 1, 2 or 3" });
        }

        const user = await fetchUser(res, username);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        if (String(user.Role) === "1" || role === 1) {
          return res.status(403).json({
            error: "Forbidden: cannot change the role of an admin",
          });
        }

        await DBConnection.query(
          "UPDATE users SET Role = ? WHERE Username = ?",
          [role, username]
        );

        const updated = await fetchUser(res, username);
        res.json({ message: "User role updated", user: updated });
      } catch (err) {
        console.error("Admin promote failed:", err);
        res.status(500).json({ error: "Failed to update user role" });
      }
    }
  );

  // ---------------------------------------------------------------------
  // Worker tier (role 2)
  // ---------------------------------------------------------------------
  router.get("/worker", auth, requireRole(2), (req, res) => {
    res.json({
      tier: "worker",
      message: "Welcome to the worker dashboard",
      user: req.user,
    });
  });

  router.get("/worker/clients", auth, requireRole(2), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT Username, Balance FROM users WHERE Role = 3"
      );
      res.json({ clients: rows });
    } catch (err) {
      console.error("Worker clients lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  router.post(
    "/worker/clients/balance",
    auth,
    requireRole(2),
    async (req, res) => {
      try {
        const { username, balance } = req.body;

        if (!username || balance === undefined) {
          return res
            .status(400)
            .json({ error: "username and balance are required" });
        }

        if (
          typeof balance !== "number" ||
          !Number.isFinite(balance) ||
          balance < 0
        ) {
          return res
            .status(400)
            .json({ error: "balance must be a non-negative number" });
        }

        const [result] = await DBConnection.query(
          "UPDATE users SET Balance = ? WHERE Username = ? AND Role = 3",
          [balance, username]
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Client not found" });
        }

        res.json({ message: "Balance updated", username, balance });
      } catch (err) {
        console.error("Worker balance update failed:", err);
        res.status(500).json({ error: "Failed to update balance" });
      }
    }
  );

  router.post("/worker/insurances", auth, requireRole(2), async (req, res) => {
    try {
      const b = req.body || {};
      const policyNumber = b.PolicyNumber ?? b.policyNumber ?? "";
      const blancNumber = b.BlancNumber ?? b.blancNumber ?? "";
      const carNumber = b.CarNumber ?? b.carNumber ?? "";
      let price = String(b.Price ?? b.price ?? "0");
      const currencyType = normalizePolicyCurrency(b.CurrencyType ?? b.currencyType ?? "");
      const duration = parseDurationDays(b.Duration ?? b.duration ?? 0);
      const branch = b.Branch ?? b.branch ?? "";
      const otomobil = b.Otomobil ?? b.otomobil ?? "";
      // Turkish lira only applies to Auto policies at Lesovo / Kap Andreevo.
      const currencyError = validatePolicyCurrency(branch, otomobil, currencyType);
      if (currencyError) {
        return res.status(400).json({ error: currencyError });
      }
      const requestedPayment = resolvePaymentType(
        b.Cash ?? b.cash ?? b.PaymentType ?? b.paymentType
      );
      let startDate = b.StartDate ?? b.startDate ?? null;
      if (startDate === "") startDate = null;

      // Broker is no longer typed on the form. It is inferred from the sender
      // ("From" address) of the unread email the policy is created from.
      const emailFrom = b.EmailFrom ?? b.emailFrom ?? "";
      const isEmailPolicy = String(emailFrom).trim() !== "";

      // Email policies are paid ONLY from the broker's balance - never in cash
      // and never by card. Walk-ins are paid in cash or by card and can never
      // use a broker balance. (A legacy client sending `Cash: true` for an
      // email policy is accepted and stored as "Broker".)
      if (isEmailPolicy && requestedPayment === "Card") {
        return res.status(400).json({
          error: "Email policies are paid from the broker balance only",
        });
      }
      if (!isEmailPolicy && requestedPayment === "Broker") {
        return res.status(400).json({
          error: "Only email policies can be paid from a broker balance",
        });
      }
      const paymentType = isEmailPolicy ? "Broker" : requestedPayment;

      // Optional surcharges. The non-Turk tax (+5, already included in Price)
      // only applies to walk-ins: an email policy carrying it is rejected (its
      // price would include a +5 the broker must not be charged for). The +2
      // card tax goes to the bank and is visual-only during creation, so it is
      // never stored on the policy or in any balance.
      const nonTurk = toFlag(b.NonTurk ?? b.nonTurk);
      if (isEmailPolicy && nonTurk) {
        return res.status(400).json({
          error: "The non-Turk tax only applies to walk-in policies",
        });
      }
      const cardFee = false;

      // Optional return-email handling. When the form was opened from an
      // unread email, the client sends the original Gmail message ID plus any
      // files the worker dropped. If the "test" checkbox disables return
      // emails, we skip replying entirely.
      const messageId = b.MessageId ?? b.messageId ?? null;
      const disableReturnEmail = Boolean(
        b.DisableReturnEmail ?? b.disableReturnEmail ?? false
      );
      let attachments = b.Attachments ?? b.attachments ?? [];
      if (!Array.isArray(attachments)) attachments = [];

      // Blank, car and policy number are required for every policy (walk-ins
      // and email cards alike). Whitespace alone does not count.
      if (!String(blancNumber).trim()) {
        return res.status(400).json({ error: "BlancNumber is required" });
      }
      if (!String(carNumber).trim()) {
        return res.status(400).json({ error: "CarNumber is required" });
      }
      if (!String(policyNumber).trim()) {
        return res.status(400).json({ error: "PolicyNumber is required" });
      }

      // An email card policy is answered with a return email carrying the
      // policy files; it must not be created without at least one attachment
      // that actually has content.
      const validAttachments = attachments.filter((a) => a && a.base64);
      if (messageId && !disableReturnEmail && validAttachments.length === 0) {
        return res.status(400).json({
          error: "Attach at least one file before saving an email policy",
        });
      }

      // The creation time is computed by the CLIENT (the worker's local
      // wall-clock time) and stored as sent. Older clients that do not send it
      // fall back to the server clock shifted by their TzOffset.
      const sentCreationDate = b.CreationDate ?? b.creationDate;
      let creationDate;
      if (sentCreationDate !== undefined && sentCreationDate !== null && sentCreationDate !== "") {
        creationDate = parseClientDateTime(sentCreationDate);
        if (!creationDate) {
          return res.status(400).json({
            error: "CreationDate must be in YYYY-MM-DD HH:MM:SS format",
          });
        }
      } else {
        creationDate = clientLocalDateTime(b.TzOffset ?? b.tzOffset ?? null);
      }

      // An email policy is paid from its broker's balance, so the sender must
      // resolve to a broker. Without one there is no balance to charge.
      let broker = null;
      if (isEmailPolicy) {
        broker = await resolveBrokerByEmail(DBConnection, emailFrom);
        if (!broker) {
          return res.status(400).json({
            error: "The email sender is not linked to a broker",
          });
        }
      }
      const brokerId = broker ? broker.id : null;
      // Walk-ins have no broker of their own, so the branch that issued them is
      // recorded as their broker (insurance.Broker). BrokerId stays NULL: it is
      // what marks a policy as paid from a real broker's balance, and walk-ins
      // are always paid in cash or by card.
      const brokerName = broker ? broker.name : String(branch);

      // For a sub-broker, the sale price saved in the database and used to
      // calculate what each broker owes us must always be the main broker's
      // price (never the sub-broker's display price).
      if (brokerId !== null) {
        try {
          const [[subCheck]] = await DBConnection.query(
            "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
            [brokerId]
          );
          if (subCheck) {
            await attachSubBrokerStatus(DBConnection, [subCheck]);
            if (subCheck.IsSubBroker) {
              const saleEff = await salePricingFor(DBConnection, brokerId);
              const mainTariffPrice = computePolicyTariffPrice(
                {
                  Otomobil: otomobil,
                  Duration: duration,
                  NonTurk: nonTurk ? 1 : 0,
                  CardFee: cardFee ? 1 : 0,
                  PaymentType: paymentType,
                },
                saleEff.pricing
              );
              if (mainTariffPrice !== null) {
                price = String(mainTariffPrice);
              }
            }
          }
        } catch {
          // Ignore in minimal test mocks.
        }
      }

      const priceDecimal = toDecimal(price);

      // A broker that an admin has manually cut off (the "cut off" button in the
      // brokers list) cannot have new insurances created until re-enabled. This
      // is no longer automatic: being "two weeks behind on payment" now only
      // highlights the row and enables the button.
      if (brokerId !== null) {
        const [[brokerRow]] = await DBConnection.query(
          "SELECT CashBalance, CutOff FROM brokers WHERE id = ?",
          [brokerId]
        );
        const currentBalance = brokerRow ? Number(brokerRow.CashBalance) : 0;
        const cutOff = brokerRow ? Boolean(brokerRow.CutOff) : false;

        if (cutOff) {
          return res.status(403).json({
            error:
              "Broker is cut off; new insurances cannot be created until the broker is re-enabled",
          });
        }

        // Optional hard stop (admin toggle): when negative-balance broker
        // requests are disabled, reject a request that would drive the broker's
        // balance below zero. Independent of the manual cut-off above.
        if (priceDecimal !== null && priceDecimal > 0) {
          const allowNegative = await getBrokerAllowNegativeBalance(DBConnection);
          if (!allowNegative && currentBalance - priceDecimal < 0) {
            return res.status(400).json({
              error: "Broker request rejected: negative balance not allowed",
            });
          }
        }
      }

      let replyError = null;
      await DBConnection.withTransaction(async (conn) => {

        await conn.query(
          `INSERT INTO insurance
              (Author, CreationDate, PolicyNumber, BlancNumber, CarNumber, Price,
               CurrencyType, Duration, Broker, Branch, Otomobil, PaymentType,
               StartDate, BrokerId, NonTurk, CardFee)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.username,
            creationDate,
            policyNumber,
            blancNumber,
            String(carNumber).trim(),
            price,
            currencyType,
            duration,
            brokerName,
            branch,
            otomobil,
            paymentType,
            startDate,
            brokerId,
            nonTurk ? 1 : 0,
            cardFee ? 1 : 0,
          ]
        );

        // Every created insurance contributes its value to one of the three
        // payment types counted in Total cash:
        //
        //   Cash   (walk-in) -> the cash drawer (current cash) goes up.
        //   Card   (walk-in) -> the card balance goes up (Card channel).
        //   Broker (email)   -> paid from the broker's balance, which is
        //                       reduced below. That money already entered the
        //                       drawer when the broker topped up, so current
        //                       cash does NOT go up again; the payment is only
        //                       recorded under the Broker channel.
        //
        // The author is the logged-in user and the reason is the blanc number.
        if (priceDecimal !== null && priceDecimal > 0) {
          await movePolicyMoney(conn, paymentType, "increase", {
            branch,
            username: req.user.username,
            amount: priceDecimal,
            reason: blancNumber,
            currency: currencyType,
          }, creationDate);
        }

        // Flat fee: when the sender's email is associated with a broker, the
        // policy price is deducted from that broker's balance (which may go
        // negative). Creating an email insurance therefore REDUCES the broker
        // balance - that reduction is what pays for the policy. The blanc is
        // marked used by the inserted row itself (inactive blancs are
        // calculated from the broker's blanc batches).
        if (brokerId !== null) {
          await decreaseBrokerForInsurance(conn, brokerId, price, {
            reason: blancNumber,
            author: req.user.username,
            blancNumber,
            createdAt: creationDate,
          });
        }
      });

      // Reply to the original sender (unless disabled) with the dropped files.
      // This runs outside the DB transaction; a mailing failure must not roll
      // back an otherwise successfully saved insurance.
      if (!disableReturnEmail && messageId && attachments.length) {
        try {
          await sendReply(messageId, attachments);
        } catch (err) {
          replyError = err && err.message ? err.message : String(err);
          console.error("Failed to send reply email:", err);
        }
      }

      res.status(201).json({
        message: "Insurance created",
        blancNumber,
        author: req.user.username,
        replySkipped: disableReturnEmail,
        replyError: replyError || undefined,
      });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ error: "Insurance with this BlancNumber already exists" });
      }
      console.error("Worker insurance create failed:", err);
      res.status(500).json({ error: "Failed to create insurance" });
    }
  });

  // POST /worker/insurances/reply
  // Send a text reply back to the original sender of an unread email. Used by
  // the dedicated reply field at the bottom of the add-insurance form when it
  // was opened from an email card.
  router.post(
    "/worker/insurances/reply",
    auth,
    requireRole(2),
    async (req, res) => {
      try {
        const messageId = req.body?.messageId ?? req.body?.MessageId ?? null;
        const bodyText = String(
          req.body?.bodyText ?? req.body?.BodyText ?? ""
        ).trim();

        if (!messageId) {
          return res.status(400).json({ error: "messageId is required" });
        }
        if (!bodyText) {
          return res.status(400).json({ error: "bodyText is required" });
        }

        await sendReply(messageId, [], bodyText);
        res.json({ message: "Reply sent" });
      } catch (err) {
        console.error("Worker insurance reply failed:", err);
        res.status(500).json({
          error: err && err.message ? err.message : "Failed to send reply",
        });
      }
    }
  );

  // ---------------------------------------------------------------------
  // Client tier (role 3)
  // ---------------------------------------------------------------------
  router.get("/client", auth, requireRole(3), (req, res) => {
    res.json({
      tier: "client",
      message: "Welcome to the client portal",
      user: req.user,
    });
  });

  router.get("/client/profile", auth, requireRole(3), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT Username, Role, Balance FROM users WHERE Username = ?",
        [req.user.username]
      );
      res.json({ profile: rows[0] || null });
    } catch (err) {
      console.error("Client profile lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  router.get("/client/insurances", auth, requireRole(3), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        "SELECT * FROM insurance WHERE Broker = ? AND Deleted = 0",
        [req.user.username]
      );

      let brokerRow = null;
      try {
        const bId = req.user.brokerId ? Number(req.user.brokerId) : null;
        const [bRows] = bId
          ? await DBConnection.query(
              "SELECT id, Name, ParentBrokerId FROM brokers WHERE id = ?",
              [bId]
            )
          : await DBConnection.query(
              "SELECT id, Name, ParentBrokerId FROM brokers WHERE Name = ?",
              [req.user.username]
            );
        if (bRows && bRows.length > 0) {
          await attachSubBrokerStatus(DBConnection, bRows);
          brokerRow = bRows[0];
        }
      } catch {
        brokerRow = null;
      }

      if (brokerRow && brokerRow.IsSubBroker) {
        if (brokerRow.hidePricing) {
          return res.json({
            insurances: rows.map((r) => ({
              ...r,
              Price: null,
              CurrencyType: null,
            })),
          });
        }
        const subPricing = await loadOwnBrokerTariffs(
          DBConnection,
          brokerRow.id
        );
        return res.json({
          insurances: rows.map((r) => {
            const displayPrice = computePolicyTariffPrice(r, subPricing);
            return {
              ...r,
              Price: displayPrice !== null ? String(displayPrice) : null,
              CurrencyType: displayPrice === null ? null : r.CurrencyType,
            };
          }),
        });
      }

      res.json({ insurances: rows });
    } catch (err) {
      console.error("Client insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  // ---------------------------------------------------------------------
  // Shared insurance endpoints (roles 1 and 2)
  // ---------------------------------------------------------------------

  // GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=&broker=&annulled=&payment=
  // Returns insurances matching any combination of the supplied filters.
  // At least one filter must be provided. Author/date match exactly (date
  // compares only the calendar day); policyNumber/blancNumber/carNumber use a
  // partial (substring) match so partially-remembered numbers still work. The
  // broker is matched in JavaScript (not SQL) so it is insensitive to the
  // Cyrillic/Latin script difference: "Lesovo" finds the walk-in policies stored
  // under the "ГКПП Лесово" branch and "kap andreevo" finds "ГКПП Капитан
  // Андреево". ?annulled=1 restricts the result to annulled policies only, and
  // ?payment=Cash|Card|Broker restricts it to a single payment type.
  router.get("/insurances", auth, requireRole(1, 2), async (req, res) => {
    try {
      const author = req.query.author ? String(req.query.author).trim() : "";
      const date = req.query.date ? String(req.query.date).trim() : "";
      const policyNumber = req.query.policyNumber
        ? String(req.query.policyNumber).trim()
        : "";
      const blancNumber = req.query.blancNumber
        ? String(req.query.blancNumber).trim()
        : "";
      const carNumber = req.query.carNumber
        ? String(req.query.carNumber).trim()
        : "";
      const broker = req.query.broker ? String(req.query.broker).trim() : "";
      const annulled = ["1", "true", "yes"].includes(
        String(req.query.annulled || "").toLowerCase()
      );
      const PAYMENT_TYPES = { cash: "Cash", card: "Card", broker: "Broker" };
      const paymentRaw = req.query.payment
        ? String(req.query.payment).trim()
        : "";
      const payment = paymentRaw
        ? PAYMENT_TYPES[paymentRaw.toLowerCase()] || ""
        : "";

      if (paymentRaw && !payment) {
        return res
          .status(400)
          .json({ error: "payment must be one of Cash, Card or Broker" });
      }

      if (
        !author &&
        !date &&
        !policyNumber &&
        !blancNumber &&
        !carNumber &&
        !broker &&
        !annulled &&
        !payment
      ) {
        return res.status(400).json({
          error:
            "At least one search parameter is required (author, date, policyNumber, blancNumber, carNumber, broker, payment or annulled)",
        });
      }

      if (date && !/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return res
          .status(400)
          .json({ error: "date must be in YYYY-MM-DD format" });
      }

      // Deleted (soft-deleted) insurances are excluded by default so they stop
      // being parsed/surfaced, regardless of the other filters applied. Admins
      // can look them up with ?includeDeleted=1 (e.g. to audit a deletion);
      // the flag is ignored for workers, who never see deleted policies.
      const includeDeleted =
        String(req.user && req.user.role) === "1" &&
        ["1", "true", "yes"].includes(
          String(req.query.includeDeleted || "").toLowerCase()
        );
      const conditions = includeDeleted ? ["1 = 1"] : ["Deleted = 0"];
      const params = [];

      if (author) {
        conditions.push("Author = ?");
        params.push(author);
      }
      if (date) {
        conditions.push("DATE(CreationDate) = DATE(?)");
        params.push(date);
      }
      if (policyNumber) {
        conditions.push("PolicyNumber LIKE ?");
        params.push(`%${policyNumber}%`);
      }
      if (blancNumber) {
        conditions.push("BlancNumber LIKE ?");
        params.push(`%${blancNumber}%`);
      }
      if (carNumber) {
        conditions.push("CarNumber LIKE ?");
        params.push(`%${carNumber}%`);
      }
      if (annulled) {
        conditions.push("Annulled = 1");
      }
      if (payment) {
        conditions.push("PaymentType = ?");
        params.push(payment);
      }

      const [rows] = await DBConnection.query(
        `SELECT * FROM insurance WHERE ${conditions.join(
          " AND "
        )} ORDER BY CreationDate DESC`,
        params
      );

      // Broker filtering runs here (not in SQL) so the name match can be
      // script-insensitive: a Latin query such as "Lesovo" still finds the
      // walk-in policies whose Broker column holds the Cyrillic branch name.
      const resultRows = broker
        ? rows.filter((row) => brokerNameMatches(row.Broker, broker))
        : rows;

      res.json({ insurances: resultRows });
    } catch (err) {
      console.error("Insurance search lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  // PATCH /insurances/:blancNumber
  // Modify an existing insurance. Admins (role 1) and workers (role 2) can
  // edit any policy.
  //
  // The edit is also applied to the money the policy represents: a policy
  // contributes its price to current cash (PaymentType = "Cash") or to the card
  // balance (PaymentType = "Card"), so changing Price, PaymentType, Branch or
  // CurrencyType of an EXISTING policy reverses its old contribution and applies
  // the new one in the same transaction as the row update. Without that, the
  // balance shown in "Current cash" would silently drift away from the policies
  // behind it every time an old policy is corrected.
  router.patch(
    "/insurances/:blancNumber",
    auth,
    requireRole(1, 2),
    async (req, res) => {
      try {
        const { blancNumber } = req.params;

        const [existing] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "Insurance not found" });
        }

        const insurance = existing[0];

        if (insurance.Deleted) {
          return res
            .status(400)
            .json({ error: "Cannot modify a deleted insurance" });
        }

        const b = req.body || {};
        const sets = [];
        const params = [];

        const editable = [
          ["PolicyNumber", b.PolicyNumber ?? b.policyNumber],
          ["Price", b.Price ?? b.price],
          ["CurrencyType", b.CurrencyType ?? b.currencyType],
          ["Branch", b.Branch ?? b.branch],
          ["Otomobil", b.Otomobil ?? b.otomobil],
          ["PaymentType", b.PaymentType ?? b.paymentType ?? b.Cash ?? b.cash],
          ["StartDate", b.StartDate ?? b.startDate],
          ["NonTurk", b.NonTurk ?? b.nonTurk],
          ["CardFee", b.CardFee ?? b.cardFee],
        ];

        // Resulting payment type after this edit; the card fee is only valid
        // when the payment is NOT cash.
        const newPaymentRaw =
          b.PaymentType ?? b.paymentType ?? b.Cash ?? b.cash;
        const hasNewPayment =
          newPaymentRaw !== undefined && newPaymentRaw !== null;

        // Email (broker-linked) policies are paid ONLY from the broker's
        // balance: their payment type is always "Broker" and cannot be changed
        // to Cash or Card. Walk-ins stay Cash/Card and can never become Broker.
        const isEmailPolicy = isBrokerLinked(insurance);
        const requestedPayment = hasNewPayment
          ? resolvePaymentType(newPaymentRaw)
          : null;
        if (isEmailPolicy && hasNewPayment && requestedPayment !== "Broker") {
          return res.status(400).json({
            error: "Email policies are paid from the broker balance only",
          });
        }
        if (!isEmailPolicy && requestedPayment === "Broker") {
          return res.status(400).json({
            error: "Only email policies can be paid from a broker balance",
          });
        }
        // The non-Turk tax only applies to walk-ins, so an email policy can
        // never be flagged with it. (Sending it as false is still accepted, so
        // a legacy row that carries the flag can be cleared.)
        const nonTurkValue = b.NonTurk ?? b.nonTurk;
        if (
          isEmailPolicy &&
          nonTurkValue !== undefined &&
          nonTurkValue !== null &&
          toFlag(nonTurkValue)
        ) {
          return res.status(400).json({
            error: "The non-Turk tax only applies to walk-in policies",
          });
        }
        const finalPayment = isEmailPolicy
          ? "Broker"
          : requestedPayment ?? resolvePaymentType(insurance.PaymentType);
        let cardFeeHandled = false;

        for (const [column, value] of editable) {
          if (value !== undefined && value !== null) {
            let v;
            if (column === "PaymentType") v = finalPayment;
            else if (column === "Price") v = String(value);
            else if (column === "NonTurk") v = toFlag(value) ? 1 : 0;
            else if (column === "CurrencyType") v = normalizePolicyCurrency(value);
            else if (column === "CardFee") {
              // The +2 card tax goes to the bank and is visual-only; it is
              // never stored on the policy or in any balance.
              v = 0;
              cardFeeHandled = true;
            } else v = value;
            sets.push(`${column} = ?`);
            params.push(v);
          }
        }

        // Clear any legacy stored card fee flag.
        if (!cardFeeHandled && insurance.CardFee) {
          sets.push("CardFee = ?");
          params.push(0);
        }

        // A walk-in's broker is the branch that issued it, so moving it to
        // another branch moves its recorded broker along. Email policies keep
        // the real broker they were created for, and so do legacy walk-ins whose
        // broker was typed by hand (i.e. is neither empty nor the old branch).
        const editedBranch = b.Branch ?? b.branch;
        const storedBroker = String(insurance.Broker ?? "");
        if (
          !isEmailPolicy &&
          editedBranch !== undefined &&
          editedBranch !== null &&
          (storedBroker === "" ||
            storedBroker === String(insurance.Branch ?? "")) &&
          String(editedBranch) !== storedBroker
        ) {
          sets.push("Broker = ?");
          params.push(String(editedBranch));
        }

        // Duration is stored as integer days, so parse it the same way the
        // creation endpoint does.
        if (b.Duration !== undefined || b.duration !== undefined) {
          const duration = parseDurationDays(b.Duration ?? b.duration);
          sets.push("Duration = ?");
          params.push(duration);
        }

        // Car number is required on creation, so an empty value is rejected
        // here too instead of silently wiping the stored one.
        const carNumberValue = b.CarNumber ?? b.carNumber;
        if (carNumberValue !== undefined && carNumberValue !== null) {
          const carNumber = String(carNumberValue).trim();
          if (!carNumber) {
            return res.status(400).json({ error: "CarNumber is required" });
          }
          sets.push("CarNumber = ?");
          params.push(carNumber);
        }

        // The blank number is the policy's key (and the URL parameter), so it
        // can only be changed to a number no other policy uses yet. The row is
        // still located by its CURRENT number in the WHERE clause below.
        let newBlancNumber = String(insurance.BlancNumber ?? blancNumber);
        const blancValue = b.BlancNumber ?? b.blancNumber;
        if (blancValue !== undefined && blancValue !== null) {
          const requestedBlanc = String(blancValue).trim();
          if (!requestedBlanc) {
            return res.status(400).json({ error: "BlancNumber is required" });
          }
          if (requestedBlanc !== newBlancNumber) {
            const [clash] = await DBConnection.query(
              "SELECT BlancNumber FROM insurance WHERE BlancNumber = ?",
              [requestedBlanc]
            );
            if (
              clash.some(
                (r) => String(r.BlancNumber) !== String(insurance.BlancNumber)
              )
            ) {
              return res
                .status(409)
                .json({ error: "Insurance with this BlancNumber already exists" });
            }
            sets.push("BlancNumber = ?");
            params.push(requestedBlanc);
            newBlancNumber = requestedBlanc;
          }
        }

        // Admins (role 1) can change who is at fault and the fee for an
        // already-annulled insurance, and can also un-annul (restore) it so it
        // stands as a normal policy again. Workers cannot change the fault or fee
        // once the policy has been annulled, and active (non-annulled) policies
        // must be annulled through POST /insurances/:blancNumber/annul first.
        const isAdmin = Number(req.user && req.user.role) === 1;
        // Annulled arrives as a checkbox: unticking it (false/0) means "remove
        // the annulment". A truthy value is only meaningful on a policy that is
        // already annulled, where it is simply a no-op.
        const rawAnnulled = b.Annulled ?? b.annulled;
        let unannul = false;
        if (rawAnnulled !== undefined && rawAnnulled !== null) {
          if (!toFlag(insurance.Annulled)) {
            return res
              .status(400)
              .json({ error: "Insurance is not annulled" });
          }
          if (!toFlag(rawAnnulled)) {
            if (!isAdmin) {
              return res.status(403).json({
                error: "Only admins can restore an annulled insurance",
              });
            }
            unannul = true;
          }
        }
        const rawAnnulPayer =
          b.AnnulReason ?? b.annulReason ?? b.payer ?? b.Payer;
        const rawAnnulFee = b.AnnulFee ?? b.annulFee ?? b.fee ?? b.Fee;
        let nextAnnulPayer = null;
        let nextAnnulFee = null;
        // Un-annulling takes precedence over a fault/fee tweak in the same save:
        // the form still submits the fault dropdown, but it is irrelevant once
        // the annulment is being removed.
        if (!unannul) {
          if (rawAnnulPayer !== undefined && rawAnnulPayer !== null) {
            if (!insurance.Annulled) {
              return res
                .status(400)
                .json({ error: "Insurance is not annulled" });
            }
            if (!isAdmin) {
              return res.status(403).json({
                error: "Only admins can change the fault of an annulled insurance",
              });
            }
            nextAnnulPayer = String(rawAnnulPayer).trim().toLowerCase();
            if (!ANNUL_PAYERS.includes(nextAnnulPayer)) {
              return res.status(400).json({
                error: "payer must be one of 'broker', 'worker' or 'none'",
              });
            }
          }
          if (
            rawAnnulFee !== undefined &&
            rawAnnulFee !== null &&
            rawAnnulFee !== ""
          ) {
            if (!insurance.Annulled) {
              return res
                .status(400)
                .json({ error: "Insurance is not annulled" });
            }
            if (!isAdmin) {
              return res.status(403).json({
                error: "Only admins can change the fee of an annulled insurance",
              });
            }
            nextAnnulFee = toDecimal(rawAnnulFee);
            if (
              nextAnnulFee === null ||
              !Number.isFinite(nextAnnulFee) ||
              nextAnnulFee < 0
            ) {
              return res
                .status(400)
                .json({ error: "fee must be a non-negative number" });
            }
          }
        }

        if (
          sets.length === 0 &&
          nextAnnulPayer === null &&
          nextAnnulFee === null &&
          !unannul
        ) {
          return res.status(400).json({ error: "Nothing to update" });
        }

        // -------------------------------------------------------------------
        // Money side-effects of the edit.
        //
        // Creating a policy adds its price to current cash (PaymentType =
        // "Cash") or to the card balance (PaymentType = "Card"). Editing one of
        // the fields that decide WHERE and HOW MUCH that is - Price,
        // PaymentType, Branch or CurrencyType - has to move the money too, so
        // the old contribution is reversed and the new one applied. Both run
        // inside the same transaction as the row update, so the ledger and the
        // policy can never disagree: when the reversal cannot be funded, the
        // whole edit is rolled back and nothing changes.
        //
        // Annulled policies are skipped - annulment already refunded their
        // price out of the cash/card balance, so they no longer contribute to
        // it and correcting their fields must not move money a second time.
        // -------------------------------------------------------------------
        const oldPrice = toDecimal(insurance.Price) || 0;
        const newPriceValue = b.Price ?? b.price;
        const newPrice =
          newPriceValue !== undefined && newPriceValue !== null
            ? toDecimal(newPriceValue) || 0
            : oldPrice;

        // Legacy email rows stored as "Cash" were funded by the broker balance,
        // so they count as "Broker" here too.
        const oldPayment = effectivePayment(insurance);
        const oldBranch = String(insurance.Branch ?? "");
        const oldCurrency = insurance.CurrencyType;

        const newBranchValue = b.Branch ?? b.branch;
        const newBranch =
          newBranchValue !== undefined && newBranchValue !== null
            ? String(newBranchValue)
            : oldBranch;
        const newCurrencyValue = b.CurrencyType ?? b.currencyType;
        const newCurrency = normalizePolicyCurrency(
          newCurrencyValue !== undefined && newCurrencyValue !== null
            ? newCurrencyValue
            : oldCurrency
        );

        // Turkish lira only applies to Auto policies at the Lesovo / Kap
        // Andreevo border crossings. Validate the edited combination before
        // any money moves or the row is written.
        const newOtomobilValue = b.Otomobil ?? b.otomobil;
        const newOtomobil =
          newOtomobilValue !== undefined && newOtomobilValue !== null
            ? String(newOtomobilValue)
            : String(insurance.Otomobil ?? "");
        const currencyError = validatePolicyCurrency(
          newBranch,
          newOtomobil,
          newCurrency
        );
        if (currencyError) {
          return res.status(400).json({ error: currencyError });
        }

        // Nothing money-related changed (e.g. only the policy number or the
        // start date was corrected): the balances are left untouched, so no
        // pointless reversal/entry pair lands in the ledger.
        const branchChanged = newBranch !== oldBranch;
        const priceChanged = newPrice !== oldPrice;
        const paymentChanged = finalPayment !== oldPayment;
        const currencyChanged =
          String(newCurrency ?? "") !== String(oldCurrency ?? "");
        const moneyChanged =
          branchChanged || priceChanged || paymentChanged || currencyChanged;

        // If an admin is changing the fault or the fee of an annulled insurance,
        // compute the old and new fees/refunds so the payment channel and (for
        // email policies) the broker's balance are adjusted by the difference.
        let annulFaultChange = null;
        if (nextAnnulPayer !== null || nextAnnulFee !== null) {
          const oldPayerRaw = String(insurance.AnnulReason ?? "")
            .trim()
            .toLowerCase();
          const hasStoredFee =
            insurance.AnnulFee !== undefined &&
            insurance.AnnulFee !== null &&
            insurance.AnnulFee !== "";
          const oldPayer = ANNUL_PAYERS.includes(oldPayerRaw)
            ? oldPayerRaw
            : hasStoredFee && (toDecimal(insurance.AnnulFee) || 0) > 0
            ? "worker"
            : "none";
          const oldFee = hasStoredFee
            ? toDecimal(insurance.AnnulFee) || 0
            : computeAnnulFee(insurance, new Date(), oldPayer).fee;

          // When only the fee is changed the payer stays as it was.
          const effectivePayer =
            nextAnnulPayer !== null ? nextAnnulPayer : oldPayer;

          const editedStartDate =
            b.StartDate !== undefined || b.startDate !== undefined
              ? b.StartDate ?? b.startDate
              : insurance.StartDate;
          const oldStartParsed = parseStartDate(insurance.StartDate);
          const newStartParsed = parseStartDate(editedStartDate);
          const startDateChanged =
            (oldStartParsed ? oldStartParsed.getTime() : null) !==
            (newStartParsed ? newStartParsed.getTime() : null);

          // No fault is always free. An admin's manual fee wins when given;
          // otherwise a fault change keeps the stored fee (unless the start
          // date moved, which re-decides it), and a fresh fee is computed when
          // there is nothing sensible to keep.
          let newFee;
          if (effectivePayer === "none") {
            newFee = 0;
          } else if (nextAnnulFee !== null) {
            newFee = nextAnnulFee;
          } else if (
            nextAnnulPayer !== null &&
            oldPayer !== "none" &&
            hasStoredFee &&
            oldFee > 0 &&
            !startDateChanged
          ) {
            newFee = oldFee;
          } else {
            newFee = computeAnnulFee(
              { ...insurance, StartDate: editedStartDate },
              new Date(),
              effectivePayer
            ).fee;
          }

          const oldRefund = Math.max(0, Math.round((newPrice - oldFee) * 100) / 100);
          const newRefund = Math.max(0, Math.round((newPrice - newFee) * 100) / 100);
          const refundDelta = Math.round((newRefund - oldRefund) * 100) / 100;
          const oldBrokerRefund = oldPayer === "broker" ? oldRefund : newPrice;
          const newBrokerRefund = effectivePayer === "broker" ? newRefund : newPrice;
          const brokerRefundDelta =
            Math.round((newBrokerRefund - oldBrokerRefund) * 100) / 100;

          annulFaultChange = {
            refundDelta,
            newBrokerRefund,
            brokerRefundDelta,
          };

          sets.push("AnnulReason = ?");
          params.push(effectivePayer);
          sets.push("AnnulFee = ?");
          params.push(newFee);
        }

        // Un-annulling reverses the annulment's money effect: the refund the
        // annulment paid out goes back into the channel the policy was paid
        // through, and a broker-linked policy is charged again for what the
        // annulment had returned to it. The kept fee folds back into the price,
        // so the policy contributes its full price once more.
        let unannulPlan = null;
        if (unannul) {
          const oldPayerRaw = String(insurance.AnnulReason ?? "")
            .trim()
            .toLowerCase();
          const hasStoredFee =
            insurance.AnnulFee !== undefined &&
            insurance.AnnulFee !== null &&
            insurance.AnnulFee !== "";
          const oldPayer = ANNUL_PAYERS.includes(oldPayerRaw)
            ? oldPayerRaw
            : hasStoredFee && (toDecimal(insurance.AnnulFee) || 0) > 0
            ? "worker"
            : "none";
          const oldFee = hasStoredFee
            ? toDecimal(insurance.AnnulFee) || 0
            : computeAnnulFee(insurance, new Date(), oldPayer).fee;
          const refund =
            Math.max(0, Math.round((oldPrice - oldFee) * 100) / 100);
          const brokerRefund = oldPayer === "broker" ? refund : oldPrice;
          unannulPlan = { refund, brokerRefund };

          sets.push("Annulled = ?");
          params.push(0);
          sets.push("AnnulReason = ?");
          params.push(null);
          sets.push("AnnulFee = ?");
          params.push(null);
          sets.push("AnnulDate = ?");
          params.push(null);
          sets.push("AnnulBy = ?");
          params.push(null);
        }

        params.push(blancNumber);
        const moveTime = resolveMoveCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }
        await DBConnection.withTransaction(async (conn) => {
          if (moneyChanged && !insurance.Annulled) {
            // 1) If the policy moved to another branch, transfer its standing
            //    money to the new branch and re-branch its ledger rows so the
            //    policy's history follows it. This replaces the old
            //    "reduce @ old branch" + "increase @ new branch" pair, which
            //    stranded the original "increase" entry under the old branch.
            if (branchChanged) {
              await movePolicyBranch(conn, oldPayment, {
                fromBranch: oldBranch,
                toBranch: newBranch,
                amount: oldPrice,
                reason: blancNumber,
                currency: oldCurrency,
              });
            }

            // 2) A price / payment-type / currency correction is then applied
            //    in the branch the policy now lives in (the new branch after a
            //    move, the old one otherwise). Email policies always go through
            //    the Broker channel, so they never touch current cash.
            const deltaBranch = branchChanged ? newBranch : oldBranch;
            if (priceChanged || paymentChanged || currencyChanged) {
              if (oldPrice > 0) {
                await movePolicyMoney(conn, oldPayment, "reduce", {
                  branch: deltaBranch,
                  username: req.user.username,
                  amount: oldPrice,
                  reason: `Edit ${blancNumber}`,
                  currency: oldCurrency,
                }, moveTime.createdAt);
              }
              if (newPrice > 0) {
                await movePolicyMoney(conn, finalPayment, "increase", {
                  branch: deltaBranch,
                  username: req.user.username,
                  amount: newPrice,
                  reason: newBlancNumber,
                  currency: newCurrency,
                }, moveTime.createdAt);
              }
            }

            // 3) Keep the broker's own balance in step with the corrected price.
            //    For an email policy that balance is the only record of the
            //    payment, so a price correction has to move it too - without
            //    touching InactivePolicies, since the policy is still active.
            if (isEmailPolicy && newPrice !== oldPrice) {
              await adjustBrokerForPriceChange(
                conn,
                insurance.BrokerId,
                Math.round((newPrice - oldPrice) * 100) / 100,
                {
                  reason: `Price change ${insurance.BlancNumber}`,
                  author: req.user.username,
                  blancNumber: insurance.BlancNumber,
                  createdAt: moveTime.createdAt,
                }
              );
            }
          }

          if (annulFaultChange) {
            if (annulFaultChange.refundDelta !== 0) {
              await movePolicyMoney(
                conn,
                finalPayment,
                annulFaultChange.refundDelta > 0 ? "reduce" : "increase",
                {
                  branch: newBranch,
                  username: req.user.username,
                  amount: Math.round(Math.abs(annulFaultChange.refundDelta) * 100) / 100,
                  reason: `Annul ${newBlancNumber}`,
                  currency: newCurrency,
                },
                moveTime.createdAt
              );
            }

            if (isEmailPolicy && annulFaultChange.brokerRefundDelta !== 0) {
              await restoreBrokerForAnnulment(
                conn,
                insurance.BrokerId,
                annulFaultChange.brokerRefundDelta,
                {
                  reason: `Annul ${newBlancNumber}`,
                  author: req.user.username,
                  blancNumber: newBlancNumber,
                  createdAt: moveTime.createdAt,
                  updateExisting: true,
                  totalRefund: annulFaultChange.newBrokerRefund,
                }
              );
            }
          }

          if (unannulPlan) {
            if (unannulPlan.refund > 0) {
              await movePolicyMoney(
                conn,
                effectivePayment(insurance),
                "increase",
                {
                  branch: insurance.Branch,
                  username: req.user.username,
                  amount: unannulPlan.refund,
                  reason: `Restore ${newBlancNumber}`,
                  currency: insurance.CurrencyType,
                },
                moveTime.createdAt
              );
            }
            if (isBrokerLinked(insurance) && unannulPlan.brokerRefund > 0) {
              await decreaseBrokerForInsurance(
                conn,
                insurance.BrokerId,
                unannulPlan.brokerRefund,
                {
                  reason: `Restore ${newBlancNumber}`,
                  author: req.user.username,
                  blancNumber: newBlancNumber,
                  createdAt: moveTime.createdAt,
                }
              );
            }
          }

          await conn.query(
            `UPDATE insurance SET ${sets.join(", ")} WHERE BlancNumber = ?`,
            params
          );
        });

        // Re-read under the (possibly changed) blank number.
        const [rows] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [newBlancNumber]
        );
        res.json({ message: "Insurance updated", insurance: rows[0] });
      } catch (err) {
        // Another policy took the new blank number between the check and the
        // UPDATE.
        if (err?.code === "ER_DUP_ENTRY") {
          return res
            .status(409)
            .json({ error: "Insurance with this BlancNumber already exists" });
        }
        // The cash drawer cannot fund the reversal of the old price (the money
        // was already paid out or reset). The transaction was rolled back, so
        // neither the policy nor the balances changed - report it the same way
        // the annulment endpoint does instead of a generic 500.
        const msg = (err && err.message) || "";
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Insurance update failed:", err);
        res.status(500).json({ error: "Failed to update insurance" });
      }
    }
  );

  // POST /insurances/:blancNumber/annul  { payer: "broker"|"worker"|"none", fee? }
  // Annuls a policy: refunds its price minus the annulment fee, through the
  // channel it was originally paid through (current cash, card balance, or the
  // Broker channel for email policies), and reverses its effect on the linked
  // broker's balance, if any. The caller chooses WHO pays the fee (or "none"
  // for no fault, which is free); the fee itself is 1 or 9 by the start date
  // (see computeAnnulFee), but an admin (role 1) may override it with a manual
  // fee. A broker-linked policy gets the full price back unless the broker
  // is the one at fault, in which case only the price minus the fee (the
  // partial refund) is returned to the broker's balance. A policy can only be
  // annulled once. Admins (role 1) and workers (role 2) can annul any policy.
  router.post(
    "/insurances/:blancNumber/annul",
    auth,
    requireRole(1, 2),
    async (req, res) => {
      try {
        const { blancNumber } = req.params;
        // Who pays the fee. `reason` is still accepted as an alias so an older
        // client sending { reason: "broker" | "worker" } keeps working.
        const payer = String(
          req.body?.payer ??
            req.body?.Payer ??
            req.body?.reason ??
            req.body?.Reason ??
            ""
        )
          .trim()
          .toLowerCase();

        if (!ANNUL_PAYERS.includes(payer)) {
          return res.status(400).json({
            error: "payer must be one of 'broker', 'worker' or 'none'",
          });
        }

        const [existing] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "Insurance not found" });
        }

        const insurance = existing[0];

        if (insurance.Deleted) {
          return res
            .status(400)
            .json({ error: "Cannot annul a deleted insurance" });
        }

        const alreadyAnnulled = Boolean(Number(insurance.Annulled));
        if (alreadyAnnulled && Number(req.user && req.user.role) !== 1) {
          return res.status(400).json({ error: "Insurance already annulled" });
        }

        const price = toDecimal(insurance.Price) || 0;
        const oldPayerRaw = String(insurance.AnnulReason ?? "")
          .trim()
          .toLowerCase();
        const hasStoredFee =
          insurance.AnnulFee !== undefined &&
          insurance.AnnulFee !== null &&
          insurance.AnnulFee !== "";
        const oldPayer = ANNUL_PAYERS.includes(oldPayerRaw)
          ? oldPayerRaw
          : hasStoredFee && (toDecimal(insurance.AnnulFee) || 0) > 0
          ? "worker"
          : "none";
        const oldFee = alreadyAnnulled
          ? hasStoredFee
            ? toDecimal(insurance.AnnulFee) || 0
            : computeAnnulFee(insurance, new Date(), oldPayer).fee
          : 0;

        // Admins may type the fee by hand; everyone else gets the computed fee
        // (1 before the start date, 9 once it is in effect). A "none" payer
        // (no fault) is always free, so a manual fee is ignored for it.
        const isAdmin = Number(req.user && req.user.role) === 1;
        const manualFeeRaw = req.body?.fee ?? req.body?.AnnulFee ?? req.body?.Fee;
        let manualFee = null;
        if (
          isAdmin &&
          manualFeeRaw !== undefined &&
          manualFeeRaw !== null &&
          manualFeeRaw !== ""
        ) {
          manualFee = toDecimal(manualFeeRaw);
          if (
            manualFee === null ||
            !Number.isFinite(manualFee) ||
            manualFee < 0
          ) {
            return res
              .status(400)
              .json({ error: "fee must be a non-negative number" });
          }
        }

        // No fault: 0. Otherwise 9 when the policy is already in effect (its
        // start date has been reached), 1 when it has not started yet - unless
        // an admin overrode the fee by hand.
        const computed = computeAnnulFee(insurance, new Date(), payer);
        const inEffect = computed.inEffect;
        let fee;
        if (payer === "none") {
          fee = 0;
        } else if (manualFee !== null) {
          fee = manualFee;
        } else if (
          alreadyAnnulled &&
          oldPayer !== "none" &&
          hasStoredFee &&
          oldFee > 0
        ) {
          fee = oldFee;
        } else {
          fee = computed.fee;
        }
        const refund = Math.max(0, Math.round((price - fee) * 100) / 100);

        const moveTime = resolveMoveCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }

        await DBConnection.withTransaction(async (conn) => {
          if (alreadyAnnulled) {
            const oldRefund = Math.max(0, Math.round((price - oldFee) * 100) / 100);
            const refundDelta = Math.round((refund - oldRefund) * 100) / 100;
            if (refundDelta !== 0) {
              await movePolicyMoney(
                conn,
                effectivePayment(insurance),
                refundDelta > 0 ? "reduce" : "increase",
                {
                  branch: insurance.Branch,
                  username: req.user.username,
                  amount: Math.round(Math.abs(refundDelta) * 100) / 100,
                  reason: `Annul ${blancNumber}`,
                  currency: insurance.CurrencyType,
                },
                moveTime.createdAt
              );
            }
            if (isBrokerLinked(insurance)) {
              const oldBrokerRefund = oldPayer === "broker" ? oldRefund : price;
              const newBrokerRefund = payer === "broker" ? refund : price;
              const brokerRefundDelta =
                Math.round((newBrokerRefund - oldBrokerRefund) * 100) / 100;
              if (brokerRefundDelta !== 0) {
                await restoreBrokerForAnnulment(
                  conn,
                  insurance.BrokerId,
                  brokerRefundDelta,
                  {
                    reason: `Annul ${blancNumber}`,
                    author: req.user.username,
                    blancNumber,
                    createdAt: moveTime.createdAt,
                    updateExisting: true,
                    totalRefund: newBrokerRefund,
                  }
                );
              }
            }
          } else {
            // The refund leaves through the channel the policy was paid through.
            // An email policy was paid from the broker's balance, so its refund
            // comes out of the Broker channel and never reduces current cash -
            // the drawer never received that money in the first place.
            if (refund > 0) {
              await movePolicyMoney(conn, effectivePayment(insurance), "reduce", {
                branch: insurance.Branch,
                username: req.user.username,
                amount: refund,
                reason: `Annul ${blancNumber}`,
                currency: insurance.CurrencyType,
              }, moveTime.createdAt);
            }

            if (isBrokerLinked(insurance)) {
              // The broker gets the full price back unless the broker itself is
              // at fault, in which case the annulment fee is kept back and only
              // the partial refund (price - fee) returns to the broker's balance.
              const brokerRefund = payer === "broker" ? refund : price;
              await restoreBrokerForAnnulment(
                conn,
                insurance.BrokerId,
                brokerRefund,
                {
                  reason: `Annul ${blancNumber}`,
                  author: req.user.username,
                  blancNumber,
                  createdAt: moveTime.createdAt,
                }
              );
            }
          }

          await conn.query(
            `UPDATE insurance
                SET Annulled = 1, AnnulReason = ?, AnnulFee = ?, AnnulDate = NOW(), AnnulBy = ?
              WHERE BlancNumber = ?`,
            [payer, fee, req.user.username, blancNumber]
          );
        });

        const [rows] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        res.json({
          message: alreadyAnnulled
            ? "Insurance annulment updated"
            : "Insurance annulled",
          refund,
          fee,
          payer,
          inEffect,
          insurance: rows[0],
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Insurance annulment failed:", err);
        res.status(500).json({ error: "Failed to annul insurance" });
      }
    }
  );

  // DELETE /insurances/:blancNumber  (admin panel "Delete" button)
  //
  // Soft-deletes a policy: the row is never physically removed from the
  // database, it is only tagged (Deleted = 1, DeletedAt, DeletedBy) so it
  // keeps existing for record-keeping purposes while being excluded from
  // every normal list/search endpoint (/admin/insurances, /insurances,
  // /client/insurances) and therefore from reconciliation/report parsing.
  // Admin-only; a policy can only be deleted once.
  //
  // Unlike an annulment (which refunds the price minus a fee and keeps the
  // blanc used up), a deletion undoes the policy completely, as if it had
  // never been created:
  //   - Walk-in (Cash/Card): whatever the policy still contributes is removed
  //     from current cash / the card balance and from Total cash.
  //   - Broker (email): the full price is refunded to the broker's balance,
  //     it is removed from the Broker part of Total cash, and the blanc is
  //     given back to the broker (a deleted policy no longer counts as using
  //     a blanc of its batch).
  // If the policy was annulled first, the annulment already refunded part of
  // the money; only what is still counted (the kept annulment fee) is removed,
  // and the broker is not refunded a second time - but the blanc is restored.
  router.delete(
    "/insurances/:blancNumber",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { blancNumber } = req.params;

        const [existing] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "Insurance not found" });
        }

        const insurance = existing[0];
        if (insurance.Deleted) {
          return res.status(400).json({ error: "Insurance already deleted" });
        }

        const price = toDecimal(insurance.Price) || 0;
        // What the policy still contributes to its payment channel: the full
        // price, or - after an annulment refunded `price - fee` - only the
        // part of the fee that was kept.
        let counted = price;
        if (insurance.Annulled) {
          const fee = toDecimal(insurance.AnnulFee) || 0;
          const refunded = Math.max(0, Math.round((price - fee) * 100) / 100);
          counted = Math.round((price - refunded) * 100) / 100;
        }
        const brokerRefund =
          isBrokerLinked(insurance) && !insurance.Annulled ? price : 0;

        const moveTime = resolveMoveCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }

        await DBConnection.withTransaction(async (conn) => {
          // Remove the money through the channel the policy was paid through.
          // Email policies go through the Broker channel and never touch
          // current cash.
          if (counted > 0) {
            await movePolicyMoney(conn, effectivePayment(insurance), "reduce", {
              branch: insurance.Branch,
              username: req.user.username,
              amount: counted,
              reason: `Delete ${blancNumber}`,
              currency: insurance.CurrencyType,
            }, moveTime.createdAt);
          }

          // Refund the broker (unless an annulment already did) and give the
          // blanc back.
          if (isBrokerLinked(insurance)) {
            await restoreBrokerForDeletion(
              conn,
              insurance.BrokerId,
              brokerRefund,
              {
                reason: `Delete ${blancNumber}`,
                author: req.user.username,
                blancNumber,
                createdAt: moveTime.createdAt,
              }
            );
          }

          await conn.query(
            `UPDATE insurance
                SET Deleted = 1, DeletedAt = NOW(), DeletedBy = ?
              WHERE BlancNumber = ?`,
            [req.user.username, blancNumber]
          );
        });

        res.json({
          message: "Insurance deleted",
          blancNumber,
          removed: counted,
          brokerRefund,
        });
      } catch (err) {
        // The cash drawer cannot fund the removal (the money was already paid
        // out or reset). The transaction was rolled back, so nothing changed.
        const msg = (err && err.message) || "";
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Insurance deletion failed:", err);
        res.status(500).json({ error: "Failed to delete insurance" });
      }
    }
  );

  // POST /insurances/:blancNumber/restore  (admin panel "Restore" action)
  //
  // Reverses DELETE /insurances/:blancNumber for a soft-deleted policy. The
  // policy comes back exactly as it was when it was deleted (it keeps its
  // annulled state if it had one), and the money the deletion removed is
  // re-applied:
  //   - Walk-in (Cash/Card): the amount the deletion removed is added back to
  //     current cash / the card balance and to Total cash.
  //   - Broker (email): the price the deletion refunded is charged back to the
  //     broker's balance, it is added back to the Broker part of Total cash,
  //     and the policy's blanc counts as used again (Deleted = 0).
  // Admin-only; a policy can only be restored while it is deleted.
  router.post(
    "/insurances/:blancNumber/restore",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { blancNumber } = req.params;

        const [existing] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "Insurance not found" });
        }

        const insurance = existing[0];
        if (!insurance.Deleted) {
          return res.status(400).json({ error: "Insurance is not deleted" });
        }

        const price = toDecimal(insurance.Price) || 0;
        // What the deletion removed from the payment channel: the full price,
        // or - for a policy that was annulled first - only the kept annulment
        // fee (the annulment already refunded the rest).
        let counted = price;
        if (insurance.Annulled) {
          const fee = toDecimal(insurance.AnnulFee) || 0;
          const refunded = Math.max(0, Math.round((price - fee) * 100) / 100);
          counted = Math.round((price - refunded) * 100) / 100;
        }
        // What the deletion refunded to the broker: the full price for a
        // non-annulled broker policy, nothing for an annulled one.
        const brokerCharge =
          isBrokerLinked(insurance) && !insurance.Annulled ? price : 0;

        const moveTime = resolveMoveCreatedAt(req.body);
        if (moveTime.error) {
          return res.status(400).json({ error: moveTime.error });
        }

        await DBConnection.withTransaction(async (conn) => {
          // Put the money back through the channel it was originally paid
          // through. Email policies go through the Broker channel.
          if (counted > 0) {
            await movePolicyMoney(conn, effectivePayment(insurance), "increase", {
              branch: insurance.Branch,
              username: req.user.username,
              amount: counted,
              reason: `Restore ${blancNumber}`,
              currency: insurance.CurrencyType,
            }, moveTime.createdAt);
          }

          // Re-charge the broker (unless an annulment already keeps the money
          // out of the broker's balance); restoring also re-uses its blanc.
          if (isBrokerLinked(insurance) && brokerCharge > 0) {
            await decreaseBrokerForInsurance(
              conn,
              insurance.BrokerId,
              brokerCharge,
              {
                reason: `Restore ${blancNumber}`,
                author: req.user.username,
                blancNumber,
                createdAt: moveTime.createdAt,
              }
            );
          }

          await conn.query(
            `UPDATE insurance
                SET Deleted = ?, DeletedAt = ?, DeletedBy = ?
              WHERE BlancNumber = ?`,
            [0, null, null, blancNumber]
          );
        });

        res.json({
          message: "Insurance restored",
          blancNumber,
          restored: counted,
          brokerCharge,
        });
      } catch (err) {
        const msg = (err && err.message) || "";
        if (msg.includes("insufficient")) {
          return res.status(400).json({ error: msg });
        }
        console.error("Insurance restore failed:", err);
        res.status(500).json({ error: "Failed to restore insurance" });
      }
    }
  );

  return router;
};

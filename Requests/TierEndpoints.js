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
const { recordCashMovement, toDecimal } = require("./CurrentCash.js");
const { recordCardPayment, reduceCardBalance } = require("./CardPayments.js");
const {
  resolveBrokerByEmail,
  decreaseBrokerForInsurance,
  restoreBrokerForAnnulment,
} = require("./Brokers.js");
const { sendReply } = require("../Mail/SendReply.js");

/**
 * Resolve an insurance payment type from the received value.
 *
 * A boolean `true` (or the legacy strings "true"/"1"/"yes") maps to "Cash";
 * a boolean `false` maps to "Card". The literal strings "Cash"/"Card" are
 * also accepted (case-insensitive) so the PaymentType field can be round-tripped.
 *
 * @param {unknown} value
 * @returns {"Cash"|"Card"}
 */
function resolvePaymentType(value) {
  if (typeof value === "boolean") return value ? "Cash" : "Card";
  if (value === undefined || value === null || value === "") return "Card";
  const s = String(value).trim();
  const lower = s.toLowerCase();
  if (lower === "cash") return "Cash";
  if (lower === "card") return "Card";
  return lower === "true" || lower === "1" || lower === "yes" ? "Cash" : "Card";
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
        `SELECT Username, Role, Balance, Status
         FROM users
         ORDER BY Username`
      );
      res.json({ users });
    } catch (err) {
      console.error("Admin users lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

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

  router.get("/admin/insurances", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query("SELECT * FROM insurance");
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Admin insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  router.patch(
    "/admin/users/:username",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const { username } = req.params;
        const { role, balance } = req.body;

        const [existing] = await DBConnection.query(
          "SELECT Username FROM users WHERE Username = ?",
          [username]
        );
        if (existing.length === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        const sets = [];
        const params = [];
        if (role !== undefined) {
          const r = Number(role);
          if (![1, 2, 3].includes(r)) {
            return res.status(400).json({ error: "role must be 1, 2 or 3" });
          }
          sets.push("Role = ?");
          params.push(r);
        }
        if (balance !== undefined) {
          const b = Number(balance);
          if (!Number.isFinite(b) || b < 0) {
            return res
              .status(400)
              .json({ error: "balance must be a non-negative number" });
          }
          sets.push("Balance = ?");
          params.push(b);
        }
        if (sets.length === 0) {
          return res.status(400).json({ error: "Nothing to update" });
        }

        params.push(username);
        await DBConnection.query(
          `UPDATE users SET ${sets.join(", ")} WHERE Username = ?`,
          params
        );

        const [rows] = await DBConnection.query(
          "SELECT Username, Role, Balance FROM users WHERE Username = ?",
          [username]
        );
        res.json({ message: "User updated", user: rows[0] });
      } catch (err) {
        console.error("Admin user update failed:", err);
        res.status(500).json({ error: "Failed to update user" });
      }
    }
  );

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
      const price = String(b.Price ?? b.price ?? "0");
      const currencyType = b.CurrencyType ?? b.currencyType ?? "";
      const duration = parseDurationDays(b.Duration ?? b.duration ?? 0);
      const branch = b.Branch ?? b.branch ?? "";
      const otomobil = b.Otomobil ?? b.otomobil ?? "";
      const paymentType = resolvePaymentType(
        b.Cash ?? b.cash ?? b.PaymentType ?? b.paymentType
      );
      let startDate = b.StartDate ?? b.startDate ?? null;
      if (startDate === "") startDate = null;

      // Optional surcharges (already included in Price). The card fee is only
      // valid when the payment is NOT cash.
      const nonTurk = toFlag(b.NonTurk ?? b.nonTurk);
      const cardFee = paymentType !== "Cash" && toFlag(b.CardFee ?? b.cardFee);

      // Broker is no longer typed on the form. It is inferred from the sender
      // ("From" address) of the unread email the policy is created from.
      const emailFrom = b.EmailFrom ?? b.emailFrom ?? "";

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

      if (!blancNumber) {
        return res.status(400).json({ error: "BlancNumber is required" });
      }
      if (!String(carNumber).trim()) {
        return res.status(400).json({ error: "CarNumber is required" });
      }

      const priceDecimal = toDecimal(price);

      let replyError = null;
      await DBConnection.withTransaction(async (conn) => {
        // Resolve the broker from the email sender. When no broker matches,
        // the policy is stored without a broker link.
        const broker = await resolveBrokerByEmail(conn, emailFrom);
        const brokerId = broker ? broker.id : null;
        const brokerName = broker ? broker.name : "";

        await conn.query(
          `INSERT INTO insurance
              (Author, CreationDate, PolicyNumber, BlancNumber, CarNumber, Price,
               CurrencyType, Duration, Broker, Branch, Otomobil, PaymentType,
               StartDate, BrokerId, NonTurk, CardFee)
           VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.username,
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

        // Every created insurance contributes its value to either current cash
        // (PaymentType = "Cash") or the card balance (PaymentType = "Card").
        // The author is the logged-in user and the reason is the blanc number.
        if (priceDecimal !== null && priceDecimal > 0) {
          if (paymentType === "Cash") {
            await recordCashMovement(
              conn,
              branch,
              req.user.username,
              "increase",
              priceDecimal,
              blancNumber,
              currencyType
            );
          } else {
            await recordCardPayment(
              conn,
              req.user.username,
              priceDecimal,
              blancNumber
            );
          }
        }

        // Flat fee: when the sender's email is associated with a broker, the
        // policy price is deducted from that broker's balance (which may go
        // negative) and its InactivePolicies is decremented.
        if (brokerId !== null) {
          await decreaseBrokerForInsurance(conn, brokerId, price);
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
        "SELECT * FROM insurance WHERE Broker = ?",
        [req.user.username]
      );
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Client insurances lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  // ---------------------------------------------------------------------
  // Shared insurance endpoints (roles 1 and 2)
  // ---------------------------------------------------------------------

  // GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=
  // Returns insurances matching any combination of the supplied filters.
  // At least one filter must be provided. Author/date match exactly (date
  // compares only the calendar day); policyNumber/blancNumber/carNumber use a
  // partial (substring) match so partially-remembered numbers still work.
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

      if (!author && !date && !policyNumber && !blancNumber && !carNumber) {
        return res.status(400).json({
          error:
            "At least one search parameter is required (author, date, policyNumber, blancNumber or carNumber)",
        });
      }

      if (date && !/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return res
          .status(400)
          .json({ error: "date must be in YYYY-MM-DD format" });
      }

      const conditions = [];
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

      const [rows] = await DBConnection.query(
        `SELECT * FROM insurance WHERE ${conditions.join(
          " AND "
        )} ORDER BY CreationDate DESC`,
        params
      );
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Insurance search lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch insurances" });
    }
  });

  // PATCH /insurances/:blancNumber
  // Modify an existing insurance. Admins (role 1) can edit any policy;
  // workers (role 2) can only edit policies they created themselves.
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

        // Workers can only modify their own insurances.
        if (
          String(req.user.role) === "2" &&
          insurance.Author !== req.user.username
        ) {
          return res
            .status(403)
            .json({ error: "Forbidden: can only modify your own insurances" });
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
        const finalPayment =
          newPaymentRaw !== undefined && newPaymentRaw !== null
            ? resolvePaymentType(newPaymentRaw)
            : insurance.PaymentType;
        let cardFeeHandled = false;

        for (const [column, value] of editable) {
          if (value !== undefined && value !== null) {
            let v;
            if (column === "PaymentType") v = resolvePaymentType(value);
            else if (column === "Price") v = String(value);
            else if (column === "NonTurk") v = toFlag(value) ? 1 : 0;
            else if (column === "CardFee") {
              v = finalPayment !== "Cash" && toFlag(value) ? 1 : 0;
              cardFeeHandled = true;
            } else v = value;
            sets.push(`${column} = ?`);
            params.push(v);
          }
        }

        // Switching to Cash clears a previously stored card fee flag.
        if (!cardFeeHandled && finalPayment === "Cash" && insurance.CardFee) {
          sets.push("CardFee = ?");
          params.push(0);
        }

        // Duration is stored as integer days, so parse it the same way the
        // creation endpoint does.
        if (b.Duration !== undefined || b.duration !== undefined) {
          const duration = parseDurationDays(b.Duration ?? b.duration);
          sets.push("Duration = ?");
          params.push(duration);
        }

        if (sets.length === 0) {
          return res.status(400).json({ error: "Nothing to update" });
        }

        params.push(blancNumber);
        await DBConnection.query(
          `UPDATE insurance SET ${sets.join(", ")} WHERE BlancNumber = ?`,
          params
        );

        const [rows] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        res.json({ message: "Insurance updated", insurance: rows[0] });
      } catch (err) {
        console.error("Insurance update failed:", err);
        res.status(500).json({ error: "Failed to update insurance" });
      }
    }
  );

  // Annulment fees (flat amount, in the policy's own currency) per fault
  // reason. "broker" and "worker" faults still charge a small fee to cover
  // processing costs; "none" (no fault) refunds the full price.
  const ANNUL_FEES = {
    broker: 8,
    worker: 1,
    none: 0,
  };

  // POST /insurances/:blancNumber/annul  { reason: "broker"|"worker"|"none" }
  // Annuls a policy: refunds its price (minus the fee for the given fault
  // reason) out of current cash (or the card balance, depending on how it was
  // originally paid) and reverses its effect on the linked broker's balance,
  // if any. A policy can only be annulled once. Admins (role 1) can annul any
  // policy; workers (role 2) can only annul policies they created themselves.
  router.post(
    "/insurances/:blancNumber/annul",
    auth,
    requireRole(1, 2),
    async (req, res) => {
      try {
        const { blancNumber } = req.params;
        const reason = String(req.body?.reason ?? req.body?.Reason ?? "")
          .trim()
          .toLowerCase();

        if (!Object.prototype.hasOwnProperty.call(ANNUL_FEES, reason)) {
          return res.status(400).json({
            error: "reason must be one of 'broker', 'worker' or 'none'",
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

        if (
          String(req.user.role) === "2" &&
          insurance.Author !== req.user.username
        ) {
          return res
            .status(403)
            .json({ error: "Forbidden: can only annul your own insurances" });
        }

        if (insurance.Annulled) {
          return res.status(400).json({ error: "Insurance already annulled" });
        }

        const price = toDecimal(insurance.Price) || 0;
        const fee = ANNUL_FEES[reason];
        const refund = Math.max(0, Math.round((price - fee) * 100) / 100);

        await DBConnection.withTransaction(async (conn) => {
          if (refund > 0) {
            if (insurance.PaymentType === "Cash") {
              await recordCashMovement(
                conn,
                insurance.Branch,
                req.user.username,
                "reduce",
                refund,
                `Annul ${blancNumber}`,
                insurance.CurrencyType
              );
            } else {
              await reduceCardBalance(
                conn,
                req.user.username,
                refund,
                `Annul ${blancNumber}`
              );
            }
          }

          if (insurance.BrokerId !== null && insurance.BrokerId !== undefined) {
            await restoreBrokerForAnnulment(
              conn,
              insurance.BrokerId,
              insurance.Price
            );
          }

          await conn.query(
            `UPDATE insurance
                SET Annulled = 1, AnnulReason = ?, AnnulFee = ?, AnnulDate = NOW(), AnnulBy = ?
              WHERE BlancNumber = ?`,
            [reason, fee, req.user.username, blancNumber]
          );
        });

        const [rows] = await DBConnection.query(
          "SELECT * FROM insurance WHERE BlancNumber = ?",
          [blancNumber]
        );
        res.json({
          message: "Insurance annulled",
          refund,
          fee,
          reason,
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

  return router;
};

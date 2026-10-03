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
const { recordCardPayment } = require("./CardPayments.js");
const { resolveBrokerId, decreaseBrokerForInsurance } = require("./Brokers.js");

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
  // Public
  // ---------------------------------------------------------------------
  router.get("/health", (req, res) => {
    res.json({ status: "ok", service: "InsuranceServer" });
  });

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
      const [rows] = await DBConnection.query(
        "SELECT Username, Role, Balance, PayoutPercentage, Status FROM users"
      );
      res.json({ users: rows });
    } catch (err) {
      console.error("Admin users lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  router.get("/admin/stats", auth, requireRole(1), async (req, res) => {
    try {
      const [rows] = await DBConnection.query(
        `SELECT
           SUM(Role = 1) AS admins,
           SUM(Role = 2) AS workers,
           SUM(Role = 3) AS clients,
           COUNT(*) AS total
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
        const { role, balance, payoutPercentage } = req.body;

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
        if (payoutPercentage !== undefined) {
          const p = Number(payoutPercentage);
          if (!Number.isFinite(p) || p < 0 || p > 100) {
            return res
              .status(400)
              .json({ error: "payoutPercentage must be between 0 and 100" });
          }
          sets.push("PayoutPercentage = ?");
          params.push(p);
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
          "SELECT Username, Role, Balance, PayoutPercentage FROM users WHERE Username = ?",
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

  const ADMIN_USER_COLUMNS =
    "Username, Role, Balance, PayoutPercentage, Status";

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
        "SELECT Username, Balance, PayoutPercentage FROM users WHERE Role = 3"
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
      const dkn = b.DKN ?? b.dkn ?? "";
      const policyNumber = b.PolicyNumber ?? b.policyNumber ?? "";
      const blancNumber = b.BlancNumber ?? b.blancNumber ?? "";
      const price = String(b.Price ?? b.price ?? "0");
      const currencyType = b.CurrencyType ?? b.currencyType ?? "";
      const duration = parseDurationDays(b.Duration ?? b.duration ?? 0);
      const brokerCode = b.BrokerCode ?? b.brokerCode ?? "";
      const branch = b.Branch ?? b.branch ?? "";
      const otomobil = b.Otomobil ?? b.otomobil ?? "";
      const paymentType = resolvePaymentType(b.Cash ?? b.cash);
      const clientName = b.ClientName ?? b.clientName ?? "";
      const clientAdress = b.ClientAdress ?? b.clientAdress ?? "";
      const chassisNumber = b.ChassisNumber ?? b.chassisNumber ?? "";
      const vehicleBrand = b.VehicleBrand ?? b.vehicleBrand ?? "";
      const broker = b.Broker ?? b.broker ?? req.user.username;

      if (!blancNumber) {
        return res.status(400).json({ error: "BlancNumber is required" });
      }
      if (!clientName) {
        return res.status(400).json({ error: "ClientName is required" });
      }

      // VehicleBrand column is optional (added by db/setup.js); guard old DBs.
      const [cols] = await DBConnection.query("SHOW COLUMNS FROM insurance");
      const hasVehicleBrand = cols.some((c) => c.Field === "VehicleBrand");

      let sql, params;
      if (hasVehicleBrand) {
        sql = `INSERT INTO insurance
            (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price,
             CurrencyType, Duration, BrokerCode, Branch, Otomobil, PaymentType,
             ClientName, ClientAdress, ChassisNumber, VehicleBrand, Broker)
           VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          req.user.username,
          dkn,
          policyNumber,
          blancNumber,
          price,
          currencyType,
          duration,
          brokerCode,
          branch,
          otomobil,
          paymentType,
          clientName,
          clientAdress,
          chassisNumber,
          vehicleBrand,
          broker,
        ];
      } else {
        sql = `INSERT INTO insurance
            (Author, CreationDate, DKN, PolicyNumber, BlancNumber, Price,
             CurrencyType, Duration, BrokerCode, Branch, Otomobil, PaymentType,
             ClientName, ClientAdress, ChassisNumber, Broker)
           VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          req.user.username,
          dkn,
          policyNumber,
          blancNumber,
          price,
          currencyType,
          duration,
          brokerCode,
          branch,
          otomobil,
          paymentType,
          clientName,
          clientAdress,
          chassisNumber,
          broker,
        ];
      }

      const priceDecimal = toDecimal(price);

      await DBConnection.withTransaction(async (conn) => {
        await conn.query(sql, params);

        // Every created insurance contributes its value to either current cash
        // (PaymentType = "Cash") or the card balance (PaymentType = "Card").
        // The author is the logged-in user and the reason is the blanc number.
        if (priceDecimal !== null && priceDecimal > 0) {
          if (paymentType === "Cash") {
            await recordCashMovement(
              conn,
              req.user.username,
              "increase",
              priceDecimal,
              blancNumber
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

        // Charge the policy against its broker: reduce the broker balance by
        // price × Percentage / 100 and decrement its InactivePolicies.
        const brokerId = await resolveBrokerId(conn, {
          blancNumber,
          brokerId: b.BrokerId ?? b.brokerId ?? null,
        });
        if (brokerId !== null) {
          await decreaseBrokerForInsurance(conn, brokerId, price);
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
      console.error("Worker insurance create failed:", err);
      res.status(500).json({ error: "Failed to create insurance" });
    }
  });

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
        "SELECT Username, Role, Balance, PayoutPercentage FROM users WHERE Username = ?",
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

  // GET /insurances?author=X&date=Y
  // Returns insurances created by the given author on the given date.
  router.get("/insurances", auth, requireRole(1, 2), async (req, res) => {
    try {
      const author = req.query.author;
      const date = req.query.date;

      if (!author || !date) {
        return res
          .status(400)
          .json({ error: "author and date query parameters are required" });
      }

      if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return res
          .status(400)
          .json({ error: "date must be in YYYY-MM-DD format" });
      }

      const [rows] = await DBConnection.query(
        "SELECT * FROM insurance WHERE Author = ? AND DATE(CreationDate) = DATE(?)",
        [author, date]
      );
      res.json({ insurances: rows });
    } catch (err) {
      console.error("Insurance by author/date lookup failed:", err);
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
          ["DKN", b.DKN ?? b.dkn],
          ["PolicyNumber", b.PolicyNumber ?? b.policyNumber],
          ["Price", b.Price ?? b.price],
          ["CurrencyType", b.CurrencyType ?? b.currencyType],
          ["BrokerCode", b.BrokerCode ?? b.brokerCode],
          ["Branch", b.Branch ?? b.branch],
          ["Otomobil", b.Otomobil ?? b.otomobil],
          ["PaymentType", b.PaymentType ?? b.paymentType ?? b.Cash ?? b.cash],
          ["ClientName", b.ClientName ?? b.clientName],
          ["ClientAdress", b.ClientAdress ?? b.clientAdress],
          ["ChassisNumber", b.ChassisNumber ?? b.chassisNumber],
          ["VehicleBrand", b.VehicleBrand ?? b.vehicleBrand],
          ["Broker", b.Broker ?? b.broker],
        ];

        for (const [column, value] of editable) {
          if (value !== undefined && value !== null) {
            const v =
              column === "PaymentType"
                ? resolvePaymentType(value)
                : column === "Price"
                ? String(value)
                : value;
            sets.push(`${column} = ?`);
            params.push(v);
          }
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

  return router;
};

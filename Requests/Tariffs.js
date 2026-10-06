"use strict";
// Pricing tariff management for insurance policies.
//
// Two types of tariffs:
// 1. Broker tariffs: Each broker can set custom pricing for insurance types/durations
// 2. Branch tariffs: "Walk-in" pricing for each branch (default rates)
//
// Access control:
// - Brokers (role 3) can ONLY view their own pricing
// - Workers/Admins (role 1, 2) can manage all tariffs
// - Clients (brokers) poll prices on login to update their client-side cache

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { resolveBrokerByEmail } = require("./Brokers.js");

/**
 * Create the tariffs router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createTariffsRouter = function createTariffsRouter(
  DBConnection
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireAdmin = requireRole(1);
  const requireWorkerOrAdmin = requireRole(1, 2);

  // Helper: Get broker ID from username (assuming username = broker name for now)
  // In production, you'd have a users_brokers mapping table
  async function getBrokerIdByName(brokerName) {
    const [rows] = await DBConnection.query(
      "SELECT id FROM brokers WHERE Name = ?",
      [brokerName]
    );
    return rows.length > 0 ? rows[0].id : null;
  }

  // =========================================================================
  // Broker endpoints: Brokers can only view their own pricing
  // =========================================================================

  // GET /tariffs/my-pricing — fetch broker's own tariffs
  // A broker can poll this on login to update client-side pricing cache
  router.get("/tariffs/my-pricing", auth, async (req, res) => {
    try {
      const brokerName = req.user.username;
      const brokerId = await getBrokerIdByName(brokerName);

      // The logged-in user is not a broker (e.g. a worker or admin). That is a
      // normal situation, not an error: fall back to the walk-in tariffs of the
      // requested branch (?branch=...), or an empty price list when no branch
      // was given, instead of answering 404.
      if (!brokerId) {
        const branch =
          typeof req.query.branch === "string" ? req.query.branch.trim() : "";
        const fallback = {};
        if (branch) {
          const [branchTariffs] = await DBConnection.query(
            `SELECT InsuranceType, Duration, Price
               FROM branch_tariffs
              WHERE Branch = ?
              ORDER BY InsuranceType, Duration`,
            [branch]
          );
          for (const tariff of branchTariffs) {
            if (!fallback[tariff.InsuranceType]) {
              fallback[tariff.InsuranceType] = {};
            }
            fallback[tariff.InsuranceType][tariff.Duration] = parseFloat(
              tariff.Price
            );
          }
        }
        return res.json({
          brokerName: null,
          brokerId: null,
          source: branch ? "branch" : "none",
          pricing: fallback,
        });
      }

      const [tariffs] = await DBConnection.query(
        `SELECT InsuranceType, Duration, Price
           FROM broker_tariffs
          WHERE BrokerId = ?
          ORDER BY InsuranceType, Duration`,
        [brokerId]
      );

      // Format as nested structure for easier client consumption
      const pricing = {};
      for (const tariff of tariffs) {
        if (!pricing[tariff.InsuranceType]) {
          pricing[tariff.InsuranceType] = {};
        }
        pricing[tariff.InsuranceType][tariff.Duration] = parseFloat(
          tariff.Price
        );
      }

      res.json({
        brokerName,
        brokerId,
        pricing,
      });
    } catch (err) {
      console.error("Failed to fetch broker pricing:", err);
      res.status(500).json({ error: "Failed to fetch pricing" });
    }
  });

  // GET /tariffs/policy-pricing?from=<email sender>&branch=<branch>
  // Pricing used by the add-insurance form:
  //  - Insurance created from an email card: the broker is resolved from the
  //    sender address and the broker's tariffs are returned.
  //  - Walk-ins (no sender, or sender is not a known broker / has no tariffs):
  //    the branch walk-in tariffs are returned.
  router.get(
    "/tariffs/policy-pricing",
    auth,
    requireWorkerOrAdmin,
    async (req, res) => {
      try {
        const from = typeof req.query.from === "string" ? req.query.from : "";
        const branch =
          typeof req.query.branch === "string" ? req.query.branch.trim() : "";

        const toPricing = (rows) => {
          const pricing = {};
          for (const tariff of rows) {
            if (!pricing[tariff.InsuranceType]) {
              pricing[tariff.InsuranceType] = {};
            }
            pricing[tariff.InsuranceType][tariff.Duration] = parseFloat(
              tariff.Price
            );
          }
          return pricing;
        };

        if (from.trim()) {
          const broker = await resolveBrokerByEmail(DBConnection, from);
          if (broker) {
            const [rows] = await DBConnection.query(
              `SELECT InsuranceType, Duration, Price
                 FROM broker_tariffs
                WHERE BrokerId = ?
                ORDER BY InsuranceType, Duration`,
              [broker.id]
            );
            if (rows.length) {
              return res.json({
                source: "broker",
                brokerId: broker.id,
                brokerName: broker.name,
                pricing: toPricing(rows),
              });
            }
          }
        }

        let pricing = {};
        if (branch) {
          const [rows] = await DBConnection.query(
            `SELECT InsuranceType, Duration, Price
               FROM branch_tariffs
              WHERE Branch = ?
              ORDER BY InsuranceType, Duration`,
            [branch]
          );
          pricing = toPricing(rows);
        }
        res.json({ source: "branch", branch, pricing });
      } catch (err) {
        console.error("Failed to fetch policy pricing:", err);
        res.status(500).json({ error: "Failed to fetch pricing" });
      }
    }
  );

  // GET /tariffs/broker/:brokerId — admin view a specific broker's tariffs
  router.get(
    "/tariffs/broker/:brokerId",
    auth,
    requireWorkerOrAdmin,
    async (req, res) => {
      try {
        const brokerId = parseInt(req.params.brokerId, 10);
        if (!Number.isFinite(brokerId) || brokerId <= 0) {
          return res.status(400).json({ error: "Invalid broker id" });
        }

        const [[broker]] = await DBConnection.query(
          "SELECT Name FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const [tariffs] = await DBConnection.query(
          `SELECT InsuranceType, Duration, Price
           FROM broker_tariffs
          WHERE BrokerId = ?
          ORDER BY InsuranceType, Duration`,
          [brokerId]
        );

        const pricing = {};
        for (const tariff of tariffs) {
          if (!pricing[tariff.InsuranceType]) {
            pricing[tariff.InsuranceType] = {};
          }
          pricing[tariff.InsuranceType][tariff.Duration] = parseFloat(
            tariff.Price
          );
        }

        res.json({
          brokerName: broker.Name,
          brokerId,
          pricing,
        });
      } catch (err) {
        console.error("Failed to fetch broker pricing:", err);
        res.status(500).json({ error: "Failed to fetch pricing" });
      }
    }
  );

  // =========================================================================
  // Admin endpoints: Manage broker tariffs
  // =========================================================================

  // PATCH /tariffs/broker/:brokerId — update broker's tariff for a specific type/duration
  router.patch(
    "/tariffs/broker/:brokerId",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = parseInt(req.params.brokerId, 10);
        if (!Number.isFinite(brokerId) || brokerId <= 0) {
          return res.status(400).json({ error: "Invalid broker id" });
        }

        const { insuranceType, duration, price } = req.body;

        if (!insuranceType || !duration || price === undefined) {
          return res.status(400).json({
            error: "insuranceType, duration, and price are required",
          });
        }

        const durationNum = parseInt(duration, 10);
        const priceNum = parseFloat(price);

        if (!Number.isFinite(durationNum) || durationNum <= 0) {
          return res
            .status(400)
            .json({ error: "duration must be a positive number" });
        }

        if (!Number.isFinite(priceNum) || priceNum < 0) {
          return res
            .status(400)
            .json({ error: "price must be a non-negative number" });
        }

        const [[broker]] = await DBConnection.query(
          "SELECT id FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        await DBConnection.query(
          `INSERT INTO broker_tariffs
           (BrokerId, InsuranceType, Duration, Price)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE Price = VALUES(Price)`,
          [brokerId, insuranceType, durationNum, priceNum]
        );

        res.json({
          message: "Broker tariff updated",
          brokerId,
          insuranceType,
          duration: durationNum,
          price: priceNum,
        });
      } catch (err) {
        console.error("Failed to update broker tariff:", err);
        res.status(500).json({ error: "Failed to update tariff" });
      }
    }
  );

  // POST /tariffs/broker/:brokerId/bulk — bulk update broker tariffs
  router.post(
    "/tariffs/broker/:brokerId/bulk",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const brokerId = parseInt(req.params.brokerId, 10);
        if (!Number.isFinite(brokerId) || brokerId <= 0) {
          return res.status(400).json({ error: "Invalid broker id" });
        }

        const tariffs = req.body?.tariffs;
        if (!Array.isArray(tariffs) || tariffs.length === 0) {
          return res
            .status(400)
            .json({ error: "tariffs array is required and must not be empty" });
        }

        const [[broker]] = await DBConnection.query(
          "SELECT id FROM brokers WHERE id = ?",
          [brokerId]
        );

        if (!broker) {
          return res.status(404).json({ error: "Broker not found" });
        }

        const insertedCount = await DBConnection.withTransaction(
          async (conn) => {
            let count = 0;
            for (const tariff of tariffs) {
              const { insuranceType, duration, price } = tariff;

              if (!insuranceType || !duration || price === undefined) {
                throw new Error(
                  "Each tariff must have insuranceType, duration, and price"
                );
              }

              const durationNum = parseInt(duration, 10);
              const priceNum = parseFloat(price);

              if (!Number.isFinite(durationNum) || durationNum <= 0) {
                throw new Error("duration must be a positive number");
              }

              if (!Number.isFinite(priceNum) || priceNum < 0) {
                throw new Error("price must be a non-negative number");
              }

              await conn.query(
                `INSERT INTO broker_tariffs
               (BrokerId, InsuranceType, Duration, Price)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE Price = VALUES(Price)`,
                [brokerId, insuranceType, durationNum, priceNum]
              );
              count++;
            }
            return count;
          }
        );

        res.json({
          message: "Broker tariffs updated",
          brokerId,
          count: insertedCount,
        });
      } catch (err) {
        console.error("Failed to bulk update broker tariffs:", err);
        const msg = (err && err.message) || "";
        if (msg.includes("tariff must have")) {
          return res.status(400).json({ error: msg });
        }
        res.status(500).json({ error: "Failed to update tariffs" });
      }
    }
  );

  // =========================================================================
  // Branch walk-in tariffs (Admin only)
  // =========================================================================

  // GET /tariffs/branch/:branchName — get branch walk-in pricing
  router.get("/tariffs/branch/:branchName", auth, async (req, res) => {
    try {
      const branchName = decodeURIComponent(req.params.branchName);

      const [tariffs] = await DBConnection.query(
        `SELECT InsuranceType, Duration, Price
           FROM branch_tariffs
          WHERE Branch = ?
          ORDER BY InsuranceType, Duration`,
        [branchName]
      );

      const pricing = {};
      for (const tariff of tariffs) {
        if (!pricing[tariff.InsuranceType]) {
          pricing[tariff.InsuranceType] = {};
        }
        pricing[tariff.InsuranceType][tariff.Duration] = parseFloat(
          tariff.Price
        );
      }

      res.json({
        branch: branchName,
        pricing,
      });
    } catch (err) {
      console.error("Failed to fetch branch pricing:", err);
      res.status(500).json({ error: "Failed to fetch pricing" });
    }
  });

  // PATCH /tariffs/branch/:branchName — update branch walk-in tariff
  router.patch(
    "/tariffs/branch/:branchName",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const branchName = decodeURIComponent(req.params.branchName);
        const { insuranceType, duration, price } = req.body;

        if (!insuranceType || !duration || price === undefined) {
          return res.status(400).json({
            error: "insuranceType, duration, and price are required",
          });
        }

        const durationNum = parseInt(duration, 10);
        const priceNum = parseFloat(price);

        if (!Number.isFinite(durationNum) || durationNum <= 0) {
          return res
            .status(400)
            .json({ error: "duration must be a positive number" });
        }

        if (!Number.isFinite(priceNum) || priceNum < 0) {
          return res
            .status(400)
            .json({ error: "price must be a non-negative number" });
        }

        await DBConnection.query(
          `INSERT INTO branch_tariffs
           (Branch, InsuranceType, Duration, Price)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE Price = VALUES(Price)`,
          [branchName, insuranceType, durationNum, priceNum]
        );

        res.json({
          message: "Branch tariff updated",
          branch: branchName,
          insuranceType,
          duration: durationNum,
          price: priceNum,
        });
      } catch (err) {
        console.error("Failed to update branch tariff:", err);
        res.status(500).json({ error: "Failed to update tariff" });
      }
    }
  );

  // POST /tariffs/branch/:branchName/bulk — bulk update branch tariffs
  router.post(
    "/tariffs/branch/:branchName/bulk",
    auth,
    requireAdmin,
    async (req, res) => {
      try {
        const branchName = decodeURIComponent(req.params.branchName);
        const tariffs = req.body?.tariffs;

        if (!Array.isArray(tariffs) || tariffs.length === 0) {
          return res
            .status(400)
            .json({ error: "tariffs array is required and must not be empty" });
        }

        const insertedCount = await DBConnection.withTransaction(
          async (conn) => {
            let count = 0;
            for (const tariff of tariffs) {
              const { insuranceType, duration, price } = tariff;

              if (!insuranceType || !duration || price === undefined) {
                throw new Error(
                  "Each tariff must have insuranceType, duration, and price"
                );
              }

              const durationNum = parseInt(duration, 10);
              const priceNum = parseFloat(price);

              if (!Number.isFinite(durationNum) || durationNum <= 0) {
                throw new Error("duration must be a positive number");
              }

              if (!Number.isFinite(priceNum) || priceNum < 0) {
                throw new Error("price must be a non-negative number");
              }

              await conn.query(
                `INSERT INTO branch_tariffs
               (Branch, InsuranceType, Duration, Price)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE Price = VALUES(Price)`,
                [branchName, insuranceType, durationNum, priceNum]
              );
              count++;
            }
            return count;
          }
        );

        res.json({
          message: "Branch tariffs updated",
          branch: branchName,
          count: insertedCount,
        });
      } catch (err) {
        console.error("Failed to bulk update branch tariffs:", err);
        const msg = (err && err.message) || "";
        if (msg.includes("tariff must have")) {
          return res.status(400).json({ error: msg });
        }
        res.status(500).json({ error: "Failed to update tariffs" });
      }
    }
  );

  return router;
};

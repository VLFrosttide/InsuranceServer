"use strict";
// Branch management endpoints.
//
// Admins (role 1) manage the branch registry: list all branches, create new
// ones, and enable/disable existing ones. A public GET /branches endpoint
// returns only the enabled branches so login screens can offer the current
// branch list without needing an admin session.

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const { listBranches, isBranchEnabled } = require("../db/branches.js");

/**
 * Create the branches router.
 *
 * @param {import("mysql2/promise").Pool} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createBranchesRouter = function createBranchesRouter(
  DBConnection
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireAdmin = requireRole(1);

  // Public: only the enabled branches (for login branch pickers).
  router.get("/branches", async (req, res) => {
    try {
      const rows = await listBranches(DBConnection);
      res.json({
        branches: rows
          .filter((b) => b.Enabled)
          .map((b) => ({ id: b.id, Name: b.Name })),
      });
    } catch (err) {
      console.error("Branch list lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch branches" });
    }
  });

  // Admin: every branch, including their enabled state.
  router.get("/admin/branches", auth, requireAdmin, async (req, res) => {
    try {
      const rows = await listBranches(DBConnection);
      res.json({ branches: rows });
    } catch (err) {
      console.error("Admin branch list lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch branches" });
    }
  });

  // Admin: create a new branch (enabled by default).
  router.post("/admin/branches", auth, requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.name ?? req.body?.Name ?? "").trim();
      if (!name) {
        return res.status(400).json({ error: "Branch name is required" });
      }
      if (name.length > 100) {
        return res
          .status(400)
          .json({ error: "Branch name must be 100 characters or fewer" });
      }

      const [existing] = await DBConnection.query(
        "SELECT id FROM branches WHERE Name = ?",
        [name]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: "A branch with this name already exists" });
      }

      const [result] = await DBConnection.query(
        "INSERT INTO branches (Name, Enabled) VALUES (?, 1)",
        [name]
      );

      const rows = await listBranches(DBConnection);
      const branch = rows.find((b) => b.id === result.insertId) || null;
      res.status(201).json({
        message: "Branch created",
        branch,
      });
    } catch (err) {
      console.error("Branch creation failed:", err);
      res.status(500).json({ error: "Failed to create branch" });
    }
  });

  // Admin: enable/disable a branch and/or rename it.
  router.patch("/admin/branches/:id", auth, requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid branch id" });
      }

      const b = req.body || {};
      const sets = [];
      const params = [];

      if (b.name !== undefined || b.Name !== undefined) {
        const name = String(b.name ?? b.Name ?? "").trim();
        if (!name) {
          return res.status(400).json({ error: "Branch name cannot be empty" });
        }
        if (name.length > 100) {
          return res
            .status(400)
            .json({ error: "Branch name must be 100 characters or fewer" });
        }
        const [dupe] = await DBConnection.query(
          "SELECT id FROM branches WHERE Name = ? AND id <> ?",
          [name, id]
        );
        if (dupe.length > 0) {
          return res
            .status(409)
            .json({ error: "A branch with this name already exists" });
        }
        sets.push("Name = ?");
        params.push(name);
      }

      if (b.enabled !== undefined || b.Enabled !== undefined) {
        const raw = b.enabled !== undefined ? b.enabled : b.Enabled;
        if (typeof raw !== "boolean") {
          return res
            .status(400)
            .json({ error: "enabled must be a boolean" });
        }
        sets.push("Enabled = ?");
        params.push(raw ? 1 : 0);
      }

      if (sets.length === 0) {
        return res
          .status(400)
          .json({ error: "Nothing to update (send name and/or enabled)" });
      }

      params.push(id);
      const [result] = await DBConnection.query(
        `UPDATE branches SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Branch not found" });
      }

      const rows = await listBranches(DBConnection);
      const branch = rows.find((row) => row.id === id) || null;
      res.json({ message: "Branch updated", branch });
    } catch (err) {
      console.error("Branch update failed:", err);
      res.status(500).json({ error: "Failed to update branch" });
    }
  });

  return router;
};

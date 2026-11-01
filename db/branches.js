"use strict";
// Managed branch registry.
//
// Branches are now a first-class, administrable entity: an admin can turn a
// branch on/off and create new ones. The `branches` table (created and seeded
// in db/setup.js) is the source of truth. A disabled branch blocks employee
// login and blocks the creation of new insurances through it.
//
// Enforcement is intentionally lenient for unknown/empty branch names: legacy
// policies and clients that store an unmanaged branch string keep working.

const BRANCH_COLUMNS = "id, Name, Enabled, CreatedAt";

/**
 * List every managed branch (enabled and disabled), ordered by name.
 * @param {import("mysql2/promise").Pool|import("mysql2/promise").Connection} db
 * @returns {Promise<Array<{id:number, Name:string, Enabled:boolean, CreatedAt:string}>>}
 */
async function listBranches(db) {
  const [rows] = await db.query(
    `SELECT ${BRANCH_COLUMNS} FROM branches ORDER BY Name`
  );
  return rows.map((row) => ({
    id: row.id,
    Name: row.Name,
    Enabled: Number(row.Enabled) === 1,
    CreatedAt: row.CreatedAt,
  }));
}

/**
 * Look up a single managed branch by its exact name.
 * @returns {Promise<{id:number, Name:string, Enabled:number}|null>}
 */
async function findBranchByName(db, name) {
  const [rows] = await db.query(
    "SELECT id, Name, Enabled FROM branches WHERE Name = ?",
    [String(name == null ? "" : name).trim()]
  );
  return rows[0] || null;
}

/**
 * Whether a branch is allowed to be used. Empty or unmanaged branch names are
 * treated as enabled so legacy records and clients are not suddenly blocked.
 * @returns {Promise<boolean>}
 */
async function isBranchEnabled(db, name) {
  const normalized = String(name == null ? "" : name).trim();
  if (!normalized) return true;
  try {
    const branch = await findBranchByName(db, normalized);
    if (!branch) return true;
    return Number(branch.Enabled) === 1;
  } catch (err) {
    // The branches table may not exist yet during the startup window (routes
    // are mounted before schema setup completes) or while the DB is degraded.
    // Never block login/creation on a lookup we cannot perform.
    console.warn("Branch status lookup failed:", err && err.message ? err.message : err);
    return true;
  }
}

module.exports = {
  listBranches,
  findBranchByName,
  isBranchEnabled,
};

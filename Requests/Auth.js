// Authentication and authorization middleware for the InsuranceServer API.
//
// The server authenticates users with a session token that is stored in an
// httpOnly cookie at login time. To keep API clients (e.g. Electron) flexible,
// the same token may also be supplied via an Authorization header.
//
// Suspended users (users.Status = 'suspended') are rejected even when they
// present a valid token, so an admin can immediately lock an account out. The
// same goes for a soft-deleted account (users.Deleted = 1): it keeps its row so
// an admin can restore it, but no session of it is honoured.

/**
 * Extract the session token from either an Authorization header or a cookie.
 * @param {import("express").Request} req
 * @returns {string | null}
 */
const extractToken = (module.exports.extractToken = function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim() || null;
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const pair = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("token="));
    if (pair) return pair.slice("token=".length) || null;
  }

  return null;
});

/**
 * Middleware factory that requires a valid, unexpired session token.
 * On success it attaches `req.user = { username, role }`.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").RequestHandler}
 */
module.exports.requireAuth = function requireAuth(DBConnection) {
  return async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json({ error: "Unauthorized: missing token" });
      }

      const [rows] = await DBConnection.query(
        `SELECT t.Username, u.Role, u.Status, u.BrokerId, u.Deleted
           FROM tokens t
           JOIN users u ON u.Username = t.Username
          WHERE t.Token = ? AND t.Expires > NOW()`,
        [token]
      );

      if (!rows || rows.length === 0) {
        return res
          .status(401)
          .json({ error: "Unauthorized: invalid or expired token" });
      }

      // A soft-deleted account must not be able to keep using a session that
      // survived the delete (the delete drops its tokens, this is the backstop).
      if (Number(rows[0].Deleted) === 1) {
        return res.status(403).json({ error: "Account deleted" });
      }

      if (String(rows[0].Status || "active") !== "active") {
        return res.status(403).json({ error: "Account suspended" });
      }

      req.user = {
        username: rows[0].Username,
        role: String(rows[0].Role),
        brokerId: rows[0].BrokerId ?? null,
      };
      next();
    } catch (err) {
      console.error("Authentication middleware error:", err);
      return res.status(500).json({ error: "Authentication failed" });
    }
  };
};

/**
 * Middleware that restricts a route to the given roles.
 * Must be mounted after `requireAuth` so that `req.user` is populated.
 *
 * @param {...(string|number)} allowedRoles
 * @returns {import("express").RequestHandler}
 */
module.exports.requireRole = function requireRole(...allowedRoles) {
  const allowed = allowedRoles.map(String);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!allowed.includes(String(req.user.role))) {
      return res
        .status(403)
        .json({ error: "Forbidden: insufficient permissions" });
    }
    next();
  };
};

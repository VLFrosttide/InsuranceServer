"use strict";

// Client diagnostics intake + admin inspection.
//
// WHY THIS EXISTS
// ---------------
// Some PCs intermittently get HTTP 403 answers that never reach the application
// (a CDN/WAF/antivirus/proxy in front of the API). The response headers, the
// block page and the `x-hcdn-request-id` are only visible on the CLIENT, and the
// PC may not be able to reach the server at all while the incident lasts. Each
// client therefore keeps its failed requests (and the first successful request
// after a 403, for comparison) on disk and uploads them here as soon as it can
// reach the API again.
//
//   POST   /diag/client                 - upload a batch of client reports
//   GET    /admin/diagnostics           - admin: list stored reports
//   DELETE /admin/diagnostics           - admin: delete reports (ids or all)
//   GET    /admin/diagnostics/context   - admin: how THIS server sees a request
//   GET    /admin/diagnostics/settings  - admin: is data gathering switched on?
//   PUT    /admin/diagnostics/settings  - admin: switch data gathering on/off
//
// COLLECTING IS SWITCHABLE. The switch sits in the Diagnostics tab itself: the
// admin turns it on while an incident is investigated and off again afterwards.
// While it is off, POST /diag/client still answers 200 (so clients drop their
// queued reports instead of retrying forever) but stores nothing - the data is
// not gathered at all, company-wide. The flag lives in the shared
// `app_settings` key/value table (like the broker balance setting), so it
// applies to every PC, and reports already stored stay readable.
//
// Reports are kept until an admin explicitly deletes them: nothing is pruned
// automatically, so an incident can be investigated days later.
//
// Uploads normally happen with the user's session token. A client that cannot
// log in has no token, so unauthenticated uploads are accepted as well - but
// only for reports that were captured without a token in the first place, and
// under a strict per-IP rate limit.

const express = require("express");
const { requireAuth, requireRole, extractToken } = require("./Auth.js");

// ---------------------------------------------------------------------------
// Limits. Everything coming from a client is untrusted: clamp lengths before a
// value ever reaches MySQL or an admin's browser.
// ---------------------------------------------------------------------------
const MAX_REPORTS_PER_UPLOAD = 25;
const MAX_UPLOAD_BODY_BYTES = 2 * 1024 * 1024;
const MAX_URL_CHARS = 1500;
const MAX_PATH_CHARS = 700;
const MAX_ID_CHARS = 80;
const MAX_BODY_CHARS = 96 * 1024;
const MAX_JSON_CHARS = 48 * 1024;
const MAX_USER_AGENT_CHARS = 512;
const MAX_FORWARDED_CHARS = 512;

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_ANON = 30;
const RATE_MAX_AUTHED = 120;
const RATE_MAX_TRACKED_IPS = 5000;

const KINDS = new Set([
  "failure",
  "recovery",
  "network-error",
  "websocket-error",
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function asInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.trunc(n);
  if (min !== undefined && rounded < min) return min;
  if (max !== undefined && rounded > max) return max;
  return rounded;
}

function safeJson(value, maxChars) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  if (text.length > maxChars) {
    return JSON.stringify({
      truncated: true,
      chars: text.length,
      preview: text.slice(0, maxChars),
    });
  }
  return text;
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

// DATETIME (no timezone) built from the client's UTC instant. The client's own
// wall-clock string is preserved in CapturedAtText/Extra, so nothing is lost by
// normalising the sortable column to UTC.
function toSqlDate(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) return headers[key];
  }
  return null;
}
function ipFromRequest(req, clientIp) {
  if (typeof clientIp === "function") {
    try {
      return clientIp(req);
    } catch {
      // Fall through to the plain socket address.
    }
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

// The upload's own headers are stored so the server's view of the client can be
// compared, but the session token and cookies must never be written to the DB.
// Applied to the client's captured headers too: a future/modified client must
// not be able to put a bearer token into the report.
function redactHeaderMap(headers) {
  if (!headers || typeof headers !== "object") return headers || null;
  const out = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (
      /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i.test(
        key
      )
    ) {
      out[key] = `[redacted len=${String(value || "").length}]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-IP upload rate limiter (in memory). This is a diagnostic intake, not an
// API: it must never be allowed to fill the database or the event loop.
// ---------------------------------------------------------------------------
function createRateLimiter(now) {
  const buckets = new Map(); // ip -> { count, windowStart, lastAt }

  function prune(at) {
    if (buckets.size <= RATE_MAX_TRACKED_IPS) return;
    for (const [key, bucket] of buckets) {
      if (at - bucket.lastAt > RATE_WINDOW_MS) buckets.delete(key);
      if (buckets.size <= RATE_MAX_TRACKED_IPS) break;
    }
  }

  return function hit(key, authenticated) {
    const at = typeof now === "function" ? now() : Date.now();
    const bucketKey = String(key || "unknown");
    let bucket = buckets.get(bucketKey);
    if (!bucket || at - bucket.windowStart >= RATE_WINDOW_MS) {
      bucket = { count: 0, windowStart: at, lastAt: at };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    bucket.lastAt = at;
    prune(at);
    const max = authenticated ? RATE_MAX_AUTHED : RATE_MAX_ANON;
    return {
      allowed: bucket.count <= max,
      count: bucket.count,
      max,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.windowStart + RATE_WINDOW_MS - at) / 1000)
      ),
    };
  };
}

// ---------------------------------------------------------------------------
// Token verification that never rejects: used only to attribute an upload to a
// username. The upload itself may legitimately arrive without a session (the
// client could not log in while the 403 incident was happening).
// ---------------------------------------------------------------------------
function createOptionalAuth(DBConnection) {
  return async function optionalAuth(req) {
    const token = extractToken(req);
    if (!token) return null;
    try {
      const [rows] = await DBConnection.query(
        `SELECT t.Username, u.Role
           FROM tokens t
           JOIN users u ON u.Username = t.Username
          WHERE t.Token = ? AND t.Expires > NOW()
            AND u.Deleted = 0 AND u.Status = 'active'`,
        [token]
      );
      if (!rows || rows.length === 0) return null;
      return { username: rows[0].Username, role: String(rows[0].Role) };
    } catch (err) {
      console.warn(
        "Diagnostics token check failed:",
        err && err.message ? err.message : err
      );
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// One report as stored. Returns null for anything that cannot be attributed to
// a real request (no URL).
// ---------------------------------------------------------------------------
function normalizeReport(raw, meta) {
  if (!raw || typeof raw !== "object") return null;

  const url = clip(raw.url, MAX_URL_CHARS);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  let path = clip(raw.path, MAX_PATH_CHARS);
  if (!path) {
    try {
      const parsed = new URL(url);
      path = clip(parsed.pathname + parsed.search, MAX_PATH_CHARS);
    } catch {
      path = null;
    }
  }

  const kind = KINDS.has(String(raw.kind)) ? String(raw.kind) : "failure";
  const method = clip(String(raw.method || "GET").toUpperCase(), 12);
  const status = asInt(raw.status, 0, 599);
  const capturedAtMs =
    asInt(raw.capturedAtMs, 0) ||
    Date.parse(String(raw.capturedAt || "")) ||
    null;
  const capturedAtText = clip(raw.capturedAt, 40);
  const responseHeaders = raw.responseHeaders || null;
  const requestId =
    clip(raw.requestId, MAX_ID_CHARS) ||
    clip(headerValue(responseHeaders, "x-hcdn-request-id"), MAX_ID_CHARS);

  return {
    ClientId: clip(raw.clientId || meta.clientId, MAX_ID_CHARS),
    Username: meta.username ? clip(meta.username, 45) : null,
    AuthState: meta.username ? "token" : "none",
    Kind: kind,
    Status: status,
    Method: method,
    Path: path,
    Url: url,
    RequestId: requestId,
    HasRequestId: requestId ? 1 : 0,
    CapturedAt: toSqlDate(capturedAtMs),
    CapturedAtMs: capturedAtMs || null,
    CapturedAtText: capturedAtText,
    DurationMs: asInt(raw.durationMs, 0, 24 * 60 * 60 * 1000),
    Attempt: asInt(raw.attempt, 0, 10000),
    RepeatCount: asInt(raw.repeatCount, 1, 1000000) || 1,
    PairId: clip(raw.pairId, MAX_ID_CHARS),
    SamePath:
      raw.samePath === undefined || raw.samePath === null
        ? null
        : raw.samePath
          ? 1
          : 0,
    Origin: clip(raw.origin || meta.origin, 300),
    UploadIp: clip(meta.ip, 64),
    ForwardedFor: clip(meta.forwardedFor, MAX_FORWARDED_CHARS),
    UserAgent: clip(meta.userAgent, MAX_USER_AGENT_CHARS),
    Body: clip(raw.body, MAX_BODY_CHARS),
    Headers: safeJson(redactHeaderMap(raw.responseHeaders), MAX_JSON_CHARS),
    RequestHeaders: safeJson(redactHeaderMap(raw.requestHeaders), MAX_JSON_CHARS),
    Env: safeJson(raw.env, MAX_JSON_CHARS),
    Extra: safeJson(
      {
        bodyKind: raw.bodyKind || null,
        bodyTitle: clip(raw.bodyTitle, 300),
        bodyBytes: asInt(raw.bodyBytes, 0),
        bodyTruncated: !!raw.bodyTruncated,
        errorName: clip(raw.errorName, 120),
        errorMessage: clip(raw.errorMessage, 600),
        signature: clip(raw.signature, 400),
        requestsLastMinute: asInt(raw.requestsLastMinute, 0),
        tokenPresent: !!raw.tokenPresent,
        tokenFingerprint: clip(raw.tokenFingerprint, 40),
        context: raw.context || null,
        envError: clip(raw.envError, 300),
      },
      MAX_JSON_CHARS
    ),
    UploadHeaders: safeJson(meta.headers, MAX_JSON_CHARS),
    UploadOrigin: clip(meta.origin, 300),
  };
}

// ---------------------------------------------------------------------------
// Is diagnostics COLLECTION switched on? A shared switch (see the file header).
// It is stored in `app_settings` exactly like the broker balance setting, and
// the default is ON so an existing deployment keeps collecting until an admin
// turns it off. The switch itself is shown in the Diagnostics tab.
// ---------------------------------------------------------------------------
const DIAGNOSTICS_ENABLED_SETTING = "diagnostics_enabled";

const getDiagnosticsEnabled = (module.exports.getDiagnosticsEnabled =
  async function getDiagnosticsEnabled(conn) {
    try {
      const [rows] = await conn.query(
        "SELECT value FROM app_settings WHERE name = ?",
        [DIAGNOSTICS_ENABLED_SETTING]
      );
      if (!rows.length) return true;
      return String(rows[0].value) !== "0";
    } catch (err) {
      // A missing table or a transient failure must never stop collection by
      // accident, so fall back to the default (collecting).
      return true;
    }
  });

const setDiagnosticsEnabled = (module.exports.setDiagnosticsEnabled =
  async function setDiagnosticsEnabled(conn, enabled) {
    await conn.query(
      `INSERT INTO app_settings (name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [DIAGNOSTICS_ENABLED_SETTING, enabled ? "1" : "0"]
    );
    return Boolean(enabled);
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/**
 * @param {import("mysql2/promise").Connection} DBConnection
 * @param {{
 *   clientIp?: (req: import("express").Request) => string | null,
 *   recentRequests?: () => any[],
 *   recentFailures?: () => any[],
 *   pollingStats?: () => any[],
 *   trustProxy?: () => any,
 *   now?: () => number,
 * }} [options]
 */
module.exports.createDiagnosticsRouter = function createDiagnosticsRouter(
  DBConnection,
  options = {}
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const optionalUser = createOptionalAuth(DBConnection);
  const rateLimit = createRateLimiter(options.now);
  const clientIp = options.clientIp;

  // -------------------------------------------------------------------------
  // POST /diag/client - receive a batch of reports.
  //
  // Answering 200 while collection is switched off is deliberate: a client
  // treats a successful answer as "delivered" and drops the batch, so nothing
  // stays queued on the PC and nothing is retried. The reports are simply not
  // stored, which is exactly what turning gathering off means.
  // -------------------------------------------------------------------------
  router.post("/diag/client", async (req, res) => {
    try {
      const declaredBytes = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BODY_BYTES) {
        return res.status(413).json({ error: "Diagnostic batch too large" });
      }

      // The admin switch in the Diagnostics tab: nothing is gathered while it
      // is off, whoever uploads and whatever the batch contains.
      if (!(await getDiagnosticsEnabled(DBConnection))) {
        return res.status(200).json({
          stored: 0,
          disabled: true,
          clientId: clip(req.body && req.body.clientId, MAX_ID_CHARS),
        });
      }

      const ip = ipFromRequest(req, clientIp);
      const user = await optionalUser(req);
      // Attribute the upload in the access log / health rings. Auth.js only
      // sets req.user on protected routes; this one is intentionally open.
      if (user && !req.user) {
        req.user = { username: user.username, role: user.role };
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const list = Array.isArray(body.reports) ? body.reports : [];
      if (list.length === 0) {
        return res.status(400).json({ error: "No reports submitted" });
      }
      if (list.length > MAX_REPORTS_PER_UPLOAD) {
        return res.status(413).json({
          error: `At most ${MAX_REPORTS_PER_UPLOAD} reports per upload`,
        });
      }

      // Limit per device, not only per IP: several PCs in one branch share a
      // public address (and behind a proxy there may be no X-Forwarded-For at
      // all), so an IP-only bucket would silence every other PC in that branch.
      const rate = rateLimit(`${ip || "unknown"}|${body.clientId || ""}`, !!user);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        return res.status(429).json({
          error: "Too many diagnostic uploads",
          retryAfterSeconds: rate.retryAfterSeconds,
        });
      }

      // A client WITH a token must upload WITH it (so the report can be tied to
      // an account). A client without a token may only submit reports that were
      // captured without one - typically failed login attempts. This keeps the
      // unauthenticated door narrow.
      if (!user) {
        const claimsToken = list.some(
          (report) => report && report.tokenPresent === true
        );
        if (claimsToken) {
          return res
            .status(401)
            .json({ error: "Sign in before uploading these reports" });
        }
      }

      const meta = {
        clientId: clip(body.clientId, MAX_ID_CHARS),
        ip,
        origin: clip(req.headers.origin, 300),
        forwardedFor: clip(req.headers["x-forwarded-for"], MAX_FORWARDED_CHARS),
        userAgent: clip(req.headers["user-agent"], MAX_USER_AGENT_CHARS),
        headers: redactHeaderMap(req.headers),
        username: user ? user.username : null,
      };

      const rows = [];
      for (const report of list) {
        const row = normalizeReport(report, meta);
        if (row) rows.push(row);
      }
      if (rows.length === 0) {
        return res.status(400).json({ error: "No usable reports in the batch" });
      }

      const columns = Object.keys(rows[0]);
      const values = rows.map((row) => columns.map((column) => row[column]));
      const [result] = await DBConnection.query(
        `INSERT INTO client_diagnostics (${columns.join(", ")})
         VALUES ?`,
        [values]
      );

      console.log(
        `[diagnostics] stored ${rows.length} client report(s)` +
          ` from ${ip || "?"}` +
          (user ? ` user=${user.username}` : " (no token)") +
          ` firstId=${result && result.insertId ? result.insertId : "?"}`
      );

      return res.status(201).json({
        stored: rows.length,
        firstId: result && result.insertId ? result.insertId : null,
        clientId: meta.clientId,
      });
    } catch (err) {
      console.error("Failed to store client diagnostics:", err);
      return res.status(500).json({ error: "Failed to store diagnostics" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /admin/diagnostics - list stored reports (admin only).
  // Reports stay stored until an admin deletes them.
  // -------------------------------------------------------------------------
  router.get("/admin/diagnostics", auth, requireRole(1), async (req, res) => {
    try {
      const limit = asInt(req.query.limit, 1, 1000) || 300;
      const where = [];
      const params = [];

      if (req.query.status !== undefined && req.query.status !== "") {
        const status = asInt(req.query.status, 0, 599);
        if (status === null) {
          return res.status(400).json({ error: "status must be a number" });
        }
        where.push("Status = ?");
        params.push(status);
      }
      if (req.query.kind) {
        where.push("Kind = ?");
        params.push(clip(req.query.kind, 24));
      }
      if (req.query.clientId) {
        where.push("ClientId = ?");
        params.push(clip(req.query.clientId, MAX_ID_CHARS));
      }
      if (req.query.username) {
        where.push("Username = ?");
        params.push(clip(req.query.username, 45));
      }
      if (req.query.requestId) {
        where.push("RequestId = ?");
        params.push(clip(req.query.requestId, MAX_ID_CHARS));
      }
      if (req.query.withRequestId === "1") {
        where.push("HasRequestId = 1");
      }
      if (req.query.withRequestId === "0") {
        where.push("HasRequestId = 0");
      }
      if (req.query.sinceId) {
        const sinceId = asInt(req.query.sinceId, 0);
        if (sinceId) {
          where.push("id > ?");
          params.push(sinceId);
        }
      }

      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [rows] = await DBConnection.query(
        `SELECT id, ReceivedAt, ClientId, Username, AuthState, Kind, Status,
                Method, Path, Url, RequestId, HasRequestId, CapturedAt,
                CapturedAtMs, CapturedAtText, DurationMs, Attempt, RepeatCount,
                PairId, SamePath, Origin, UploadIp, ForwardedFor, UserAgent,
                Body, Headers, RequestHeaders, Env, Extra, UploadHeaders,
                UploadOrigin
           FROM client_diagnostics
           ${clause}
          ORDER BY id DESC
          LIMIT ?`,
        [...params, limit]
      );

      const [countRows] = await DBConnection.query(
        `SELECT COUNT(*) AS Total,
                SUM(Status = 403) AS Forbidden,
                SUM(Kind = 'recovery') AS Recoveries,
                SUM(HasRequestId = 1) AS WithRequestId,
                COUNT(DISTINCT ClientId) AS Clients
           FROM client_diagnostics`
      );
      const totals = (countRows && countRows[0]) || {};

      return res.json({
        stored: Number(totals.Total || 0),
        summary: {
          total: Number(totals.Total || 0),
          forbidden: Number(totals.Forbidden || 0),
          recoveries: Number(totals.Recoveries || 0),
          withRequestId: Number(totals.WithRequestId || 0),
          clients: Number(totals.Clients || 0),
        },
        count: rows.length,
        reports: (rows || []).map((row) => ({
          ...row,
          Headers: parseJson(row.Headers),
          RequestHeaders: parseJson(row.RequestHeaders),
          Env: parseJson(row.Env),
          Extra: parseJson(row.Extra),
          UploadHeaders: parseJson(row.UploadHeaders),
        })),
      });
    } catch (err) {
      console.error("Failed to read client diagnostics:", err);
      return res
        .status(500)
        .json({ error: "Failed to read client diagnostics" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/diagnostics - the explicit "I have what I need" action.
  // Body: { ids: [1,2,3] } or { all: true }.
  // -------------------------------------------------------------------------
  router.delete("/admin/diagnostics", auth, requireRole(1), async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const ids = Array.isArray(body.ids)
        ? body.ids.map((id) => asInt(id, 1)).filter(Boolean)
        : [];
      const all = body.all === true;

      if (!all && ids.length === 0) {
        return res
          .status(400)
          .json({ error: "Provide ids to delete, or all: true" });
      }

      const [result] = all
        ? await DBConnection.query("DELETE FROM client_diagnostics")
        : await DBConnection.query(
            "DELETE FROM client_diagnostics WHERE id IN (?)",
            [ids]
          );

      return res.json({
        deleted: result && result.affectedRows ? result.affectedRows : 0,
      });
    } catch (err) {
      console.error("Failed to delete client diagnostics:", err);
      return res
        .status(500)
        .json({ error: "Failed to delete client diagnostics" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /admin/diagnostics/settings - whether data is being gathered.
  //
  // The Diagnostics tab shows the switch and its current value, so an admin can
  // see at a glance whether failures are being recorded. Admin-only, like the
  // rest of the tab; defaults to ON.
  // -------------------------------------------------------------------------
  router.get(
    "/admin/diagnostics/settings",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        res.json({ enabled: await getDiagnosticsEnabled(DBConnection) });
      } catch (err) {
        console.error("Diagnostics settings read failed:", err);
        res.status(500).json({ error: "Failed to fetch diagnostics settings" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // PUT /admin/diagnostics/settings  { enabled: boolean }
  //
  // Switch data gathering on or off for every PC. Off means new uploads are
  // discarded (nothing is stored); the reports already stored stay, and the
  // switch itself remains reachable from the tab, so it can be turned back on.
  // -------------------------------------------------------------------------
  router.put(
    "/admin/diagnostics/settings",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const raw = req.body ? req.body.enabled : undefined;
        if (raw === undefined || raw === null) {
          return res.status(400).json({ error: "enabled is required" });
        }
        const enabled =
          typeof raw === "string"
            ? !["0", "false", "off", "no", ""].includes(raw.trim().toLowerCase())
            : Boolean(raw);
        res.json({ enabled: await setDiagnosticsEnabled(DBConnection, enabled) });
      } catch (err) {
        console.error("Diagnostics settings update failed:", err);
        res
          .status(500)
          .json({ error: "Failed to update diagnostics settings" });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /admin/diagnostics/context - the server's own view of a request.
  //
  // This is the counterweight to a client report: it shows which IP the server
  // resolved (and from which header), which headers arrived, what CORS/auth
  // policy answered, and how often each IP/path was called recently (a client
  // stuck in a retry loop shows up here). Comparing it with a client report
  // answers "did the request reach us, and as whom?".
  // -------------------------------------------------------------------------
  router.get(
    "/admin/diagnostics/context",
    auth,
    requireRole(1),
    async (req, res) => {
      try {
        const headers = { ...req.headers };
        if (headers.authorization) {
          headers.authorization = `[redacted len=${String(
            headers.authorization
          ).length}]`;
        }
        if (headers.cookie) headers.cookie = "[redacted]";

        const entries = (fn) => {
          try {
            const value = typeof fn === "function" ? fn() : null;
            return Array.isArray(value) ? value : [];
          } catch {
            return [];
          }
        };

        const trustProxy =
          typeof options.trustProxy === "function"
            ? options.trustProxy()
            : null;

        return res.json({
          server: {
            time: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            uptimeSeconds: Math.round(process.uptime()),
            memoryRssBytes:
              typeof process.memoryUsage === "function"
                ? process.memoryUsage().rss
                : null,
          },
          request: {
            ip: ipFromRequest(req, clientIp),
            socketRemoteAddress:
              (req.socket && req.socket.remoteAddress) || null,
            forwardedFor: req.headers["x-forwarded-for"] || null,
            xRealIp: req.headers["x-real-ip"] || null,
            cfConnectingIp: req.headers["cf-connecting-ip"] || null,
            forwardedProto: req.headers["x-forwarded-proto"] || null,
            forwardedHost: req.headers["x-forwarded-host"] || null,
            host: req.headers.host || null,
            origin: req.headers.origin || null,
            referer: req.headers.referer || null,
            userAgent: req.headers["user-agent"] || null,
            authorizationPresent: !!req.headers.authorization,
            headers,
          },
          accessControl: {
            // The API sends these on every response (see main.js).
            cors: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods":
                "GET, POST, PUT, PATCH, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
            trustProxy,
            expressRequestBodyLimit: "50mb",
            httpKeepAliveTimeoutMs: 65000,
            httpHeadersTimeoutMs: 66000,
            authentication:
              "Bearer token or httpOnly cookie; 401 = missing/invalid/expired, " +
              "403 = account deleted/suspended or the role is not allowed",
            ipAllowList: "none - no route filters by IP address",
            rateLimits: {
              apiRoutes: "none",
              diagnosticsUpload: {
                anonymousPer10Min: RATE_MAX_ANON,
                authenticatedPer10Min: RATE_MAX_AUTHED,
              },
            },
            note:
              "A request blocked before this process never reaches these " +
              "counters; compare recent.requests with the client report.",
          },
          recent: {
            requests: entries(options.recentRequests).slice(-120),
            failures: entries(options.recentFailures).slice(-120),
            polling: entries(options.pollingStats).slice(0, 20),
          },
        });
      } catch (err) {
        console.error("Failed to build diagnostics context:", err);
        return res
          .status(500)
          .json({ error: "Failed to build diagnostics context" });
      }
    }
  );

  return router;
};

module.exports.__test = {
  normalizeReport,
  safeJson,
  clip,
  toSqlDate,
  createRateLimiter,
  MAX_REPORTS_PER_UPLOAD,
  RATE_MAX_ANON,
  RATE_MAX_AUTHED,
};

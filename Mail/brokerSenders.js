"use strict";

// Decides whether an incoming email may be shown to clients at all: only
// emails whose sender is one of the broker addresses we know about are kept,
// and — when the admin has disabled negative-balance broker requests — emails
// from brokers whose balance is already negative are hidden as well.
//
// The database (`broker_emails`, seeded from db/BrokerInfo.js and editable
// through the broker API) is the source of truth. If the database is not
// available (not configured yet, or a query fails) we fall back to the static
// lists in db/BrokerInfo.js so a DB hiccup never lets unknown senders through.

const { BrokerData } = require("../db/BrokerInfo.js");
const { extractAddress } = require("./branchRouting.js");
const {
  resolveBrokerByEmail,
  getBrokerAllowNegativeBalance,
} = require("../Requests/Brokers.js");

let db = null;

/**
 * Provide the database connection/pool used for sender lookups.
 * @param {import("mysql2/promise").Pool} DBConnection
 */
function setDb(DBConnection) {
  db = DBConnection;
}

// Static fallback: every address listed in BrokerInfo.js (lowercased/trimmed).
const staticSenders = new Set();
for (const addresses of Object.values(BrokerData)) {
  for (const address of addresses) {
    staticSenders.add(String(address).trim().toLowerCase());
  }
}

/**
 * Whether the "From" header value belongs to a known broker.
 *
 * @param {string} from  Raw "From" header, e.g. `Name <a@b.com>` or `a@b.com`.
 * @returns {Promise<boolean>}
 */
async function isKnownBrokerSender(from) {
  const address = extractAddress(from);
  if (!address) return false;

  if (db) {
    try {
      const [rows] = await db.query(
        "SELECT 1 FROM broker_emails WHERE LOWER(TRIM(Email)) = ? LIMIT 1",
        [address]
      );
      return rows.length > 0;
    } catch (err) {
      console.error(
        "Broker sender lookup failed, falling back to BrokerInfo.js:",
        err && err.message ? err.message : err
      );
    }
  }

  return staticSenders.has(address);
}

/**
 * Whether an incoming email should be shown as a card to workers.
 *
 * Extends {@link isKnownBrokerSender}: when the admin has disabled
 * negative-balance broker requests, an email from a broker whose balance is
 * already negative is hidden too (never stored, broadcast or marked read).
 * Falls back to the static broker list when the database is unavailable.
 *
 * @param {string} from  Raw "From" header, e.g. `Name <a@b.com>` or `a@b.com`.
 * @returns {Promise<boolean>}
 */
async function shouldShowBrokerEmail(from) {
  const address = extractAddress(from);
  if (!address) return false;

  if (db) {
    try {
      const broker = await resolveBrokerByEmail(db, address);
      if (!broker) return false;

      if (!(await getBrokerAllowNegativeBalance(db))) {
        const [[row]] = await db.query(
          "SELECT CashBalance FROM brokers WHERE id = ?",
          [broker.id]
        );
        if (row && Number(row.CashBalance) < 0) return false;
      }
      return true;
    } catch (err) {
      console.error(
        "Broker sender lookup failed, falling back to BrokerInfo.js:",
        err && err.message ? err.message : err
      );
    }
  }

  return staticSenders.has(address);
}

module.exports = { setDb, isKnownBrokerSender, shouldShowBrokerEmail };

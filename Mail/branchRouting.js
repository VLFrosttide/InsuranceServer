"use strict";

// Restricts which branch's workers may see emails from specific brokers.
//
//  - Emails from the Varna broker  -> only workers logged into Kapitan Andreevo
//  - Emails from the Barutcu broker -> only workers logged into Lesovo
//
// Emails from any other sender are visible to every branch.

const { BrokerData } = require("../db/BrokerInfo.js");

const KAP_ANDREEVO_BRANCH = "ГКПП Капитан Андреево";
const LESOVO_BRANCH = "ГКПП Лесово";

// Broker name (key in BrokerInfo.BrokerData) -> the single branch allowed to see it.
const BROKER_BRANCH_RESTRICTIONS = {
  Varna: KAP_ANDREEVO_BRANCH,
  Barutcu: LESOVO_BRANCH,
};

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

// emailAddress (lowercased) -> required branch
const senderToBranch = new Map();
for (const [brokerName, branch] of Object.entries(BROKER_BRANCH_RESTRICTIONS)) {
  for (const address of BrokerData[brokerName] || []) {
    senderToBranch.set(normalize(address), branch);
  }
}

// Extracts the bare address from a "From" header such as `Name <a@b.com>`.
function extractAddress(from) {
  const text = String(from || "");
  const match = text.match(/<([^>]+)>/);
  return normalize(match ? match[1] : text);
}

/**
 * Branch required to see this email, or null if it is visible to all branches.
 */
function requiredBranchFor(email) {
  if (!email) return null;
  return senderToBranch.get(extractAddress(email.from)) || null;
}

/**
 * Whether a worker logged into `branch` may see `email`.
 */
function canSeeEmail(branch, email) {
  const required = requiredBranchFor(email);
  if (!required) return true;
  return normalize(branch) === normalize(required);
}

module.exports = { canSeeEmail, requiredBranchFor, extractAddress };

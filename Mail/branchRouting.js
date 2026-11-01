"use strict";

// Email visibility is no longer restricted by branch.
//
// Previously some brokers were only serviced by a specific branch (Varna ->
// Kapitan Andreevo, Barutcu -> Lesovo). Every broker is now serviced by every
// available branch, so a worker logged into any branch can see and process any
// broker's email.

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

// Extracts the bare address from a "From" header such as `Name <a@b.com>`.
function extractAddress(from) {
  const text = String(from || "");
  const match = text.match(/<([^>]+)>/);
  return normalize(match ? match[1] : text);
}

/**
 * Branch required to see this email. Always null now: every broker is serviced
 * by every branch.
 */
function requiredBranchFor(email) {
  return null;
}

/**
 * Whether a worker logged into `branch` may see `email`. Always true now.
 */
function canSeeEmail(branch, email) {
  return true;
}

module.exports = { canSeeEmail, requiredBranchFor, extractAddress };

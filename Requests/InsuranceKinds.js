"use strict";
// The kinds (products) of insurance the system sells.
//
//   border  (Border insurance)  - the main product, sold at the border
//                                 crossings. Any employee - admin or worker -
//                                 may create it. This is also what every
//                                 policy written before the column existed is.
//   medical (Medical insurance) - admin-only: only role 1 may create one, and
//                                 only an admin may turn a policy into one.
//   civil   (Civil liability)   - same rule as medical.
//
// The kind is stored in `insurance.Kind` (VARCHAR(20) NOT NULL DEFAULT
// 'border'), so a row that carries no kind - every historical policy and any
// client that does not send one - is a border insurance. Nothing is guessed at
// read time: the column default is the rule.
//
// The rule lives in this one module so the create and edit endpoints, the list
// filter and the tests read the same list: adding a kind (or opening one to
// workers) is a single change here.

const KINDS = [
  {
    value: "border",
    label: "Border insurance",
    labelBg: "Гранична застраховка",
    adminOnly: false,
  },
  {
    value: "medical",
    label: "Medical insurance",
    labelBg: "Медицинска застраховка",
    adminOnly: true,
  },
  {
    value: "civil",
    label: "Civil liability",
    labelBg: "Гражданска отговорност",
    adminOnly: true,
  },
];

const DEFAULT_KIND = "border";
const KIND_VALUES = KINDS.map((kind) => kind.value);

/**
 * The definition of a kind, by its stored value, its English label or its
 * Bulgarian label (all case-insensitive). `null` for anything else.
 *
 * @param {unknown} value
 * @returns {{value: string, label: string, labelBg: string, adminOnly: boolean}|null}
 */
function findKind(value) {
  const raw = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return (
    KINDS.find((kind) => kind.value === raw) ||
    KINDS.find((kind) => kind.label.toLowerCase() === raw) ||
    KINDS.find((kind) => kind.labelBg.toLowerCase() === raw) ||
    null
  );
}
module.exports.findKind = findKind;

/**
 * Read the kind out of a request body. Missing/empty means the default (border
 * insurance); a value that is not a kind is an error the caller answers with
 * 400, never silently replaced by the default.
 *
 * The body may spell it `Kind`, `InsuranceKind` (either case), so a client can
 * round-trip the stored column.
 *
 * @param {object} [body]
 * @returns {{kind: string|null, provided: boolean, error: string|null}}
 */
function kindFromBody(body) {
  const b = body || {};
  const raw = b.Kind ?? b.kind ?? b.InsuranceKind ?? b.insuranceKind;
  return parseKind(raw);
}
module.exports.kindFromBody = kindFromBody;

/**
 * Normalise one raw value.
 *
 * @param {unknown} value
 * @returns {{kind: string|null, provided: boolean, error: string|null}}
 */
function parseKind(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { kind: DEFAULT_KIND, provided: false, error: null };
  }
  const found = findKind(value);
  if (!found) {
    return {
      kind: null,
      provided: true,
      error: `Kind must be one of: ${KIND_VALUES.join(", ")}`,
    };
  }
  return { kind: found.value, provided: true, error: null };
}
module.exports.parseKind = parseKind;

/**
 * The stored value of a kind, or `null` when the value is not a kind. Used for
 * rows read from the database, which always hold a stored value.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeInsuranceKind(value) {
  const found = findKind(value);
  return found ? found.value : null;
}
module.exports.normalizeInsuranceKind = normalizeInsuranceKind;

/**
 * Whether a kind may only be created/chosen by an admin. An unknown value is
 * treated as restricted, so a typo can never open an admin-only kind.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAdminOnlyKind(value) {
  const found = findKind(value);
  return found ? found.adminOnly : true;
}
module.exports.isAdminOnlyKind = isAdminOnlyKind;

/**
 * Whether this role may create (or turn a policy into) that kind.
 *
 * @param {unknown} role  The numeric role: 1 admin, 2 worker, 3 client.
 * @param {unknown} kind
 * @returns {boolean}
 */
function canUseKind(role, kind) {
  return Number(role) === 1 || !isAdminOnlyKind(kind);
}
module.exports.canUseKind = canUseKind;

/**
 * The kind of a stored policy row. A row written before the column existed (or
 * by an old server) carries no kind, which is a border insurance.
 *
 * @param {{Kind?: unknown}} insurance
 * @returns {string}
 */
function policyKind(insurance) {
  const stored = normalizeInsuranceKind(insurance && insurance.Kind);
  return stored || DEFAULT_KIND;
}
module.exports.policyKind = policyKind;

/**
 * The message a worker gets when trying to use an admin-only kind.
 *
 * @param {unknown} kind
 * @param {string} [action]  "create", "edit", "annul", ...
 * @returns {string}
 */
function adminOnlyKindError(kind, action = "create") {
  const found = findKind(kind);
  return `Only admins can ${action} ${(found ? found.label : "this kind of insurance").toLowerCase()}`;
}
module.exports.adminOnlyKindError = adminOnlyKindError;

/**
 * The list a form needs: every kind, and whether the caller may create it.
 *
 * @param {unknown} role
 * @returns {Array<{value: string, label: string, labelBg: string,
 *                  adminOnly: boolean, allowed: boolean}>}
 */
function listForRole(role) {
  return KINDS.map((kind) => ({
    value: kind.value,
    label: kind.label,
    labelBg: kind.labelBg,
    adminOnly: kind.adminOnly,
    allowed: canUseKind(role, kind.value),
  }));
}
module.exports.listForRole = listForRole;

module.exports.KINDS = KINDS;
module.exports.KIND_VALUES = KIND_VALUES;
module.exports.DEFAULT_KIND = DEFAULT_KIND;

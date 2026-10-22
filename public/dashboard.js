"use strict";

// The broker dashboard is for admins (1), workers (2), and broker-linked
// clients (3). A broker sees only their own broker (enforced by the server).
const role = getRole();
const isBroker = role === "3" && !!getBrokerId();
if (!getToken() || (role !== "1" && role !== "2" && !isBroker)) {
  clearSession();
  window.location.replace("index.html");
}

// A broker only ever has one broker, so hide the search box and relabel.
function applyBrokerMode() {
  const search = document.getElementById("BrokerSearch");
  if (search) search.style.display = isBroker ? "none" : "";
  const heading = document.querySelector(".sidebar h2");
  if (heading) heading.textContent = isBroker ? t("nav.myBroker") : t("nav.brokers");
}
applyBrokerMode();

const BrokerList = document.getElementById("BrokerList");
const BrokerSearch = document.getElementById("BrokerSearch");
const UserName = document.getElementById("UserName");
const LogoutBtn = document.getElementById("LogoutBtn");
const EmptyState = document.getElementById("EmptyState");
const Detail = document.getElementById("Detail");
const DetailName = document.getElementById("DetailName");
const StatBalance = document.getElementById("StatBalance");
const StatInactive = document.getElementById("StatInactive");
const StatPolicies = document.getElementById("StatPolicies");
const PeriodRows = document.getElementById("PeriodRows");
const TotalPolicies = document.getElementById("TotalPolicies");
const TotalMovement = document.getElementById("TotalMovement");
const PoliciesBtn = document.getElementById("PoliciesBtn");
const PaymentBanner = document.getElementById("PaymentBanner");
const PoliciesPanel = document.getElementById("PoliciesPanel");
const PoliciesRows = document.getElementById("PoliciesRows");
const PoliciesSince = document.getElementById("PoliciesSince");
const InactivePoliciesBtn = document.getElementById("InactivePoliciesBtn");
const InactivePoliciesPanel = document.getElementById("InactivePoliciesPanel");
const InactivePoliciesRows = document.getElementById("InactivePoliciesRows");
const InactivePoliciesCount = document.getElementById("InactivePoliciesCount");
const PoliciesDate = document.getElementById("PoliciesDate");
const PoliciesDatePicker = document.getElementById("PoliciesDatePicker");
const PoliciesDateClear = document.getElementById("PoliciesDateClear");
const PoliciesExportBtn = document.getElementById("PoliciesExportBtn");
const PoliciesTotalBalance = document.getElementById("PoliciesTotalBalance");
const Report = document.getElementById("Report");
const ReportFrom = document.getElementById("ReportFrom");
const ReportTo = document.getElementById("ReportTo");
const ReportBrokerBalance = document.getElementById("ReportBrokerBalance");
const ReportKapAndreevoCash = document.getElementById("ReportKapAndreevoCash");
const ReportKapAndreevoCard = document.getElementById("ReportKapAndreevoCard");
const ReportLesovoCash = document.getElementById("ReportLesovoCash");
const ReportLesovoCard = document.getElementById("ReportLesovoCard");
const ReportTotal = document.getElementById("ReportTotal");
const ReportMsg = document.getElementById("ReportMsg");
const CashInflowGrid = document.getElementById("CashInflowGrid");
const CashInflowMsg = document.getElementById("CashInflowMsg");

// The report is a company-wide aggregate, so broker accounts never see it.
// Hide immediately (before any async load) to avoid a flash of empty report.
if (Report && isBroker) Report.classList.add("hidden");

UserName.textContent = getUsername();
LogoutBtn.addEventListener("click", () => {
  clearSession();
  window.location.replace("index.html");
});

let brokers = [];
let selectedId = null;
let schedule = null;
let policiesHidePricing = false;

function isPricingHidden(b) {
  if (!b) return false;
  if (b.hidePricing !== undefined) return Boolean(b.hidePricing);
  const isSub = Boolean(b.IsSubBroker || b.isSubBroker);
  const hasParent =
    b.ParentBrokerId !== null &&
    b.ParentBrokerId !== undefined &&
    Number(b.ParentBrokerId) > 0;
  const configured = Boolean(b.PricingConfigured ?? b.pricingConfigured);
  return isSub && !(hasParent && configured);
}

function renderBrokerList() {
  const q = BrokerSearch.value.trim().toLowerCase();
  const items = brokers.filter((b) =>
    String(b.Name || "").toLowerCase().includes(q)
  );

  BrokerList.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "broker-item muted";
    li.textContent = brokers.length ? t("list.noMatches") : t("list.noBrokers");
    BrokerList.appendChild(li);
    return;
  }

  for (const b of items) {
    const li = document.createElement("li");
    li.className = "broker-item" + (b.id === selectedId ? " active" : "");
    li.dataset.id = b.id;

    const name = document.createElement("span");
    name.className = "broker-name";
    name.textContent = b.Name;

    const sub = document.createElement("span");
    sub.className = "broker-sub";
    sub.textContent = isPricingHidden(b)
      ? t("list.inactive", { n: b.InactivePolicies ?? 0 })
      : formatMoney(b.CashBalance) +
        " · " +
        t("list.inactive", { n: b.InactivePolicies ?? 0 });

    li.appendChild(name);
    li.appendChild(sub);
    li.addEventListener("click", () => selectBroker(b.id));
    BrokerList.appendChild(li);
  }
}

function renderBanner(b) {
  if (!PaymentBanner) return;
  if (!schedule || isPricingHidden(b)) {
    PaymentBanner.hidden = true;
    return;
  }
  const balance = Number(b.CashBalance || 0);
  const money = formatMoney(balance);

  let message = "";
  let variant = "";
  let cutoffLabel = "";

  if (b.cutOff) {
    variant = "danger";
    message = t("banner.cutOff", { balance: money });
  } else if (balance < 0) {
    variant = "warn";
    message = t("banner.negative", {
      balance: money,
      windowEnd: formatDate(schedule.windowEnd),
      cutoff: formatDate(schedule.cutoff),
    });
  } else {
    variant = "info";
    message = t("banner.info", {
      range: formatDateRangeHuman(schedule.windowStart, schedule.windowEnd),
    });
    cutoffLabel = schedule.cutoff
      ? t("banner.cutoffLabel", { date: formatDateLong(schedule.cutoff) })
      : "";
  }

  PaymentBanner.className = "banner " + variant;
  PaymentBanner.innerHTML = "";

  const line = document.createElement("div");
  line.className = "banner-line";
  line.textContent = message;
  PaymentBanner.appendChild(line);

  if (cutoffLabel) {
    const cutoff = document.createElement("div");
    cutoff.className = "banner-cutoff";
    cutoff.textContent = cutoffLabel;
    cutoff.setAttribute("data-tooltip", t("banner.cutoffHint"));
    cutoff.setAttribute("tabindex", "0");
    PaymentBanner.appendChild(cutoff);
  }

  PaymentBanner.hidden = false;
}

let policiesData = [];
let policySort = { key: "created", dir: -1 };
let policiesDate = "";

// Local calendar day as "YYYY-MM-DD" (built from local components, so the day
// never shifts around midnight).
function localDateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// --- Payment report (company-wide totals) ------------------------------------

// Read a number from a set of candidate field names on an object. Returns
// `undefined` when no usable value is found, so callers can chain fallbacks.
function pickPaymentValue(data, keys) {
  if (!data) return undefined;
  for (const key of keys) {
    const v = data[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// Accept both a flat shape ({ kapAndreevoCash, kapAndreevoCard, ... }) and a
// nested shape ({ kapAndreevo: { cash, card }, lesovo: { cash, card } }).
function normalizePayments(data) {
  data = data || {};
  const kap = data.kapAndreevo || data.KapAndreevo || {};
  const les = data.lesovo || data.Lesovo || {};
  return {
    kapAndreevoCash:
      pickPaymentValue(data, ["kapAndreevoCash", "KapAndreevoCash", "cashKapAndreevo"]) ??
      pickPaymentValue(kap, ["cash"]) ??
      0,
    kapAndreevoCard:
      pickPaymentValue(data, ["kapAndreevoCard", "KapAndreevoCard", "cardKapAndreevo"]) ??
      pickPaymentValue(kap, ["card"]) ??
      0,
    lesovoCash:
      pickPaymentValue(data, ["lesovoCash", "LesovoCash", "cashLesovo"]) ??
      pickPaymentValue(les, ["cash"]) ??
      0,
    lesovoCard:
      pickPaymentValue(data, ["lesovoCard", "LesovoCard", "cardLesovo"]) ??
      pickPaymentValue(les, ["card"]) ??
      0,
  };
}

// Default range = the current biweekly payment window; fall back to the last
// two weeks when no schedule is available yet.
function defaultReportRange() {
  const start = schedule && schedule.windowStart ? toDate(schedule.windowStart) : null;
  const end = schedule && schedule.windowEnd ? toDate(schedule.windowEnd) : null;
  if (start && end) return { from: localDateString(start), to: localDateString(end) };
  const e = new Date();
  const s = new Date();
  s.setDate(e.getDate() - 13);
  return { from: localDateString(s), to: localDateString(e) };
}

async function loadReport() {
  if (!Report) return;

  // Company-wide aggregate — only meaningful for admins/workers.
  if (isBroker) {
    Report.classList.add("hidden");
    return;
  }
  Report.classList.remove("hidden");

  if (!ReportFrom.value || !ReportTo.value) {
    const r = defaultReportRange();
    if (!ReportFrom.value) ReportFrom.value = r.from;
    if (!ReportTo.value) ReportTo.value = r.to;
  }

  const from = ReportFrom.value.trim();
  const to = ReportTo.value.trim();
  const qs = [];
  if (from) qs.push("from=" + encodeURIComponent(from));
  if (to) qs.push("to=" + encodeURIComponent(to));

  let payments = { kapAndreevoCash: 0, kapAndreevoCard: 0, lesovoCash: 0, lesovoCard: 0 };
  let brokerBalance = 0;
  ReportMsg.textContent = "";
  ReportMsg.className = "msg report-msg";
  try {
    const data = await api(
      "/reports/payments" + (qs.length ? "?" + qs.join("&") : "")
    );
    payments = normalizePayments(data);
    brokerBalance = pickPaymentValue(data, ["brokerBalance", "BrokerBalance"]) ?? 0;
  } catch (err) {
    ReportMsg.textContent = err.message || t("report.loadFailed");
    ReportMsg.className = "msg report-msg error";
  }

  ReportBrokerBalance.textContent = formatMoney(brokerBalance);
  ReportKapAndreevoCash.textContent = formatMoney(payments.kapAndreevoCash);
  ReportKapAndreevoCard.textContent = formatMoney(payments.kapAndreevoCard);
  ReportLesovoCash.textContent = formatMoney(payments.lesovoCash);
  ReportLesovoCard.textContent = formatMoney(payments.lesovoCard);

  const total =
    brokerBalance +
    payments.kapAndreevoCash +
    payments.kapAndreevoCard +
    payments.lesovoCash +
    payments.lesovoCard;
  ReportTotal.textContent = formatMoney(total);
}

// --- Cash inflow report (per-broker inflows) ---------------------------------

// Pull a broker name from a set of candidate field names on an entry.
function pickCashInflowName(item) {
  if (!item) return "";
  if (typeof item === "string") return item.trim();
  for (const key of [
    "brokerName",
    "BrokerName",
    "name",
    "Name",
    "broker",
    "Broker",
  ]) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

// Accept a bare array, or a wrapper object such as
// { brokers: [...] }, { items: [...] }, { entries: [...] },
// { cashInflow: [...] }, { cashInflows: [...] } or { inflows: [...] }.
function normalizeCashInflow(data) {
  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    list =
      data.brokers ||
      data.items ||
      data.entries ||
      data.cashInflow ||
      data.cashInflows ||
      data.inflows ||
      data.data ||
      [];
  }
  if (!Array.isArray(list)) list = [];

  const rows = [];
  for (const item of list) {
    const name = pickCashInflowName(item);
    const amount =
      pickPaymentValue(item, [
        "amount",
        "Amount",
        "cashInflow",
        "CashInflow",
        "inflow",
        "Inflow",
        "total",
        "Total",
        "value",
        "Value",
      ]) ?? 0;
    // Only positive inflows of at least €200 qualify.
    if (Number.isFinite(amount) && amount >= 200) {
      rows.push({
        name: name || t("report.cashInflow.unknownBroker"),
        amount,
      });
    }
  }
  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}

// Build a single cash-inflow card. `isTotal` marks the combined sum card.
function buildCashInflowCard(name, amount, isTotal) {
  const card = document.createElement("div");
  card.className = "cashinflow-card" + (isTotal ? " cashinflow-total" : "");

  const nameEl = document.createElement("span");
  nameEl.className = "cashinflow-name";
  nameEl.textContent = name;

  const amountEl = document.createElement("span");
  amountEl.className = "cashinflow-amount";
  amountEl.textContent = formatMoney(amount);

  card.appendChild(nameEl);
  card.appendChild(amountEl);
  return card;
}

async function loadCashInflow() {
  if (!CashInflowGrid) return;

  // Company-wide aggregate — only meaningful for admins/workers.
  if (isBroker) {
    CashInflowGrid.innerHTML = "";
    CashInflowMsg.textContent = "";
    CashInflowMsg.className = "msg report-msg";
    return;
  }

  if (!ReportFrom.value || !ReportTo.value) {
    const r = defaultReportRange();
    if (!ReportFrom.value) ReportFrom.value = r.from;
    if (!ReportTo.value) ReportTo.value = r.to;
  }

  const from = ReportFrom.value.trim();
  const to = ReportTo.value.trim();
  const qs = [];
  if (from) qs.push("from=" + encodeURIComponent(from));
  if (to) qs.push("to=" + encodeURIComponent(to));

  CashInflowGrid.innerHTML = "";
  CashInflowMsg.textContent = "";
  CashInflowMsg.className = "msg report-msg";

  let rows = [];
  try {
    const data = await api(
      "/reports/cash-inflow" + (qs.length ? "?" + qs.join("&") : "")
    );
    rows = normalizeCashInflow(data);
  } catch (err) {
    CashInflowMsg.textContent = err.message || t("report.cashInflow.loadFailed");
    CashInflowMsg.className = "msg report-msg error";
    return;
  }

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cashinflow-empty";
    empty.textContent = t("report.cashInflow.empty");
    CashInflowGrid.appendChild(empty);
    return;
  }

  // One combined card summing every broker inflow into a single total.
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  CashInflowGrid.appendChild(
    buildCashInflowCard(t("report.cashInflow.total"), total, true)
  );

  for (const row of rows) {
    CashInflowGrid.appendChild(buildCashInflowCard(row.name, row.amount, false));
  }
}

ReportFrom.addEventListener("change", loadReport);
ReportTo.addEventListener("change", loadReport);
ReportFrom.addEventListener("change", loadCashInflow);
ReportTo.addEventListener("change", loadCashInflow);

// Local calendar day of a policy's creation date, as "YYYY-MM-DD".
function policyDay(p) {
  const d = toDate(p.CreationDate);
  return d ? localDateString(d) : "";
}

function filteredPolicies() {
  if (!policiesDate) return policiesData.slice();
  return policiesData.filter((p) => policyDay(p) === policiesDate);
}

// Format a YYYY-MM-DD filter value into the short numeric date (DD - MM - YY).
function formatPoliciesDateValue(value) {
  if (!value) return "";
  return formatDate(value);
}

// Keep the visible text field and its clear button in sync with `policiesDate`.
function syncPoliciesDateField() {
  PoliciesDate.value = formatPoliciesDateValue(policiesDate);
  PoliciesDateClear.classList.toggle("hidden", !policiesDate);
}

// Apply a new filter date (YYYY-MM-DD) and re-render the policies table.
function setPoliciesDateFilter(value) {
  policiesDate = value || "";
  PoliciesDatePicker.value = policiesDate;
  syncPoliciesDateField();
  renderPolicyTable();
}

function renderPoliciesTotal() {
  if (policiesHidePricing) {
    PoliciesTotalBalance.textContent = "";
    PoliciesTotalBalance.classList.add("hidden");
    return;
  }
  PoliciesTotalBalance.classList.remove("hidden");
  const total = filteredPolicies().reduce((sum, p) => sum + Number(p.Price || 0), 0);
  PoliciesTotalBalance.textContent =
    t("policies.totalBalance") + ": " + formatMoney(total);
}

function policySortValue(p) {
  if (policySort.key === "created") {
    const d = toDate(p.CreationDate);
    return d ? d.getTime() : Number.NEGATIVE_INFINITY;
  }
  return policySort.key === "policy" ? p.PolicyNumber : p.BlancNumber;
}

function comparePolicies(a, b) {
  if (policySort.key === "created") {
    return policySortValue(a) - policySortValue(b);
  }
  const av = policySortValue(a);
  const bv = policySortValue(b);
  const na = Number(av);
  const nb = Number(bv);
  if (
    av != null && bv != null && av !== "" && bv !== "" &&
    !Number.isNaN(na) && !Number.isNaN(nb)
  ) {
    return na - nb;
  }
  return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true });
}

function sortedPolicies() {
  const arr = filteredPolicies();
  arr.sort((a, b) => comparePolicies(a, b) * policySort.dir);
  return arr;
}

// --- Policy field accessors (tolerant of different API field names) ----------

function policyCarNumber(p) {
  if (!p) return "";
  for (const key of [
    "CarNumber", "CarRegNumber", "CarRegistrationNumber",
    "VehicleNumber", "VehicleRegNumber", "VehicleRegistrationNumber",
    "RegistrationNumber", "RegNumber", "Registration",
    "LicensePlate", "PlateNumber", "Plate", "NumberPlate",
    "CarNo", "RegistrationNo", "RegNo", "RegPlate",
  ]) {
    const v = p[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

function policyDuration(p) {
  if (!p) return "";
  for (const key of [
    "Duration", "InsuranceDuration", "DurationMonths", "Months",
    "InsuranceMonths", "Period", "InsurancePeriod", "Term",
    "InsuranceTerm", "ValidityMonths", "DurationInMonths",
  ]) {
    const v = p[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

function isPolicyAnnulled(p) {
  if (!p) return false;
  for (const key of [
    "IsAnnulled", "isAnnulled", "Annulled", "annulled",
    "IsCanceled", "isCanceled", "IsCancelled", "isCancelled",
    "Canceled", "Cancelled",
  ]) {
    const v = p[key];
    if (v === undefined || v === null || v === "" || v === false) continue;
    const s = String(v).toLowerCase();
    if (s === "false" || s === "0" || s === "no") continue;
    return true;
  }
  const status = String(p.Status ?? p.status ?? "").toLowerCase();
  return (
    status === "annulled" ||
    status === "canceled" ||
    status === "cancelled" ||
    status === "annulment" ||
    status === "iptal" ||
    status === "anulirana"
  );
}

function updatePolicySortHeaders() {
  document.querySelectorAll("#PoliciesPanel th[data-sort]").forEach((th) => {
    const active = th.getAttribute("data-sort") === policySort.key;
    th.classList.toggle("sort-asc", active && policySort.dir === 1);
    th.classList.toggle("sort-desc", active && policySort.dir === -1);
    th.setAttribute(
      "aria-sort",
      active ? (policySort.dir === 1 ? "ascending" : "descending") : "none"
    );
  });
}

function renderPolicies(data) {
  const currentBroker = brokers.find((x) => x.id === selectedId);
  policiesHidePricing = Boolean(
    (data && data.hidePricing) ||
      (data && data.broker && isPricingHidden(data.broker)) ||
      isPricingHidden(currentBroker)
  );
  policiesData = data.policies || [];
  PoliciesSince.textContent = data.schedule
    ? t("policies.since", { date: formatDate(data.schedule.periodStart) })
    : "";
  renderPolicyTable();
}

function renderPolicyTable() {
  const priceTh = document.querySelector(
    '#PoliciesPanel th[data-i18n="policies.col.price"]'
  );
  const currTh = document.querySelector(
    '#PoliciesPanel th[data-i18n="policies.col.currency"]'
  );
  if (priceTh) priceTh.classList.toggle("hidden", policiesHidePricing);
  if (currTh) currTh.classList.toggle("hidden", policiesHidePricing);

  PoliciesRows.innerHTML = "";
  const policies = sortedPolicies();
  for (const p of policies) {
    const annulled = isPolicyAnnulled(p);
    const row = document.createElement("tr");
    if (annulled) row.classList.add("annulled");
    row.innerHTML =
      "<td>" +
      escapeHtml(p.PolicyNumber) +
      (annulled
        ? '<span class="annulled-badge">' +
          escapeHtml(t("policies.annulled")) +
          "</span>"
        : "") +
      "</td>" +
      "<td>" + escapeHtml(p.BlancNumber) + "</td>" +
      (policiesHidePricing
        ? ""
        : '<td class="num">' +
          formatMoney(p.Price) +
          "</td>" +
          "<td>" +
          escapeHtml(p.CurrencyType) +
          "</td>") +
      "<td>" + escapeHtml(formatDate(p.CreationDate)) + "</td>";
    PoliciesRows.appendChild(row);
  }
  if (policies.length === 0) {
    const emptyMessage = policiesDate ? t("policies.emptyForDate") : t("policies.empty");
    const colSpan = policiesHidePricing ? 3 : 5;
    const row = document.createElement("tr");
    row.innerHTML =
      '<td colspan="' +
      colSpan +
      '" class="policies-empty">' +
      escapeHtml(emptyMessage) +
      "</td>";
    PoliciesRows.appendChild(row);
  }
  updatePolicySortHeaders();
  renderPoliciesTotal();
}

document.querySelectorAll("#PoliciesPanel th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.getAttribute("data-sort");
    if (policySort.key === key) {
      policySort.dir *= -1;
    } else {
      policySort.key = key;
      policySort.dir = key === "created" ? -1 : 1;
    }
    renderPolicyTable();
  });
});

PoliciesDate.addEventListener("click", () => {
  if (!selectedId) return;
  try {
    PoliciesDatePicker.showPicker();
  } catch {
    PoliciesDatePicker.focus();
  }
});

PoliciesDatePicker.addEventListener("change", () => {
  setPoliciesDateFilter(PoliciesDatePicker.value || "");
});

PoliciesDateClear.addEventListener("click", () => setPoliciesDateFilter(""));

// Build an Excel (HTML table) document for a list of policies. Returns the
// full HTML string. `hidePricing` mirrors the on-screen pricing visibility.
function buildPoliciesExcel(policies, hidePricing) {
  const textCell = (v) =>
    '<td style=\'mso-number-format:"@";\'>' + escapeHtml(v) + "</td>";

  const headers = [
    t("policies.col.policy"),
    t("policies.col.blanc"),
    t("policies.col.carNumber"),
    t("policies.col.duration"),
  ];
  if (!hidePricing) {
    headers.push(t("policies.col.price"), t("policies.col.currency"));
  }
  headers.push(t("policies.col.created"), t("policies.col.status"));

  const headerHtml = headers
    .map((h) => '<th style="font-weight:bold;">' + escapeHtml(h) + "</th>")
    .join("");

  const bodyHtml = policies
    .map((p) => {
      const annulled = isPolicyAnnulled(p);
      let cells =
        textCell(p.PolicyNumber) +
        textCell(p.BlancNumber) +
        textCell(policyCarNumber(p)) +
        textCell(policyDuration(p));
      if (!hidePricing) {
        cells +=
          '<td style=\'mso-number-format:"0.00";\'>' +
          Number(p.Price || 0) +
          "</td>" +
          textCell(p.CurrencyType);
      }
      cells +=
        textCell(formatDate(p.CreationDate)) +
        textCell(annulled ? t("policies.annulled") : "");
      return (
        "<tr" +
        (annulled ? ' style="color:#9ca3af;"' : "") +
        ">" +
        cells +
        "</tr>"
      );
    })
    .join("");

  let totalHtml = "";
  if (!hidePricing) {
    const total = policies.reduce((sum, p) => sum + Number(p.Price || 0), 0);
    totalHtml =
      "<tr style='font-weight:bold;'>" +
      '<td colspan="4">' + escapeHtml(t("policies.totalSum")) + "</td>" +
      '<td style=\'mso-number-format:"0.00";\'>' + total + "</td>" +
      "<td></td><td></td><td></td>" +
      "</tr>";
  }

  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
    'xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="UTF-8">' +
    "<!--[if gte mso 9]><xml>" +
    "<x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>" +
    "<x:Name>Policies</x:Name>" +
    "<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>" +
    "</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>" +
    "</xml><![endif]-->" +
    "</head><body><table>" +
    "<tr>" +
    headerHtml +
    "</tr>" +
    bodyHtml +
    totalHtml +
    "</table></body></html>"
  );
}

function downloadExcel(html, filename) {
  const blob = new Blob([html], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Download the currently visible "Policies since last payment" rows as an
// Excel file. Uses Excel's HTML table format so the export works without any
// third-party library, and forces text cells so leading zeros are preserved.
function exportPoliciesExcel() {
  downloadExcel(
    buildPoliciesExcel(sortedPolicies(), policiesHidePricing),
    "policies-since-last-payment.xls"
  );
}

PoliciesExportBtn.addEventListener("click", exportPoliciesExcel);

async function selectBroker(id) {
  selectedId = id;
  renderBrokerList();

  const b = brokers.find((x) => x.id === id);
  if (!b) return;

  const hidePricing = isPricingHidden(b);
  policiesHidePricing = hidePricing;

  DetailName.textContent = b.Name;
  const statBalanceCard = StatBalance ? StatBalance.closest(".stat") : null;
  if (statBalanceCard) {
    statBalanceCard.classList.toggle("hidden", hidePricing);
  }
  StatBalance.textContent = hidePricing ? "" : formatMoney(b.CashBalance);
  StatInactive.textContent = b.InactivePolicies ?? 0;

  const movTh = document.querySelector(
    '#Detail th[data-i18n="table.balanceMovement"]'
  );
  if (movTh) movTh.classList.toggle("hidden", hidePricing);
  if (TotalMovement) TotalMovement.classList.toggle("hidden", hidePricing);

  const periods = b.periods || [];
  PeriodRows.innerHTML = "";

  let totalPolicies = 0;
  let totalMovement = 0;

  for (const p of periods) {
    totalPolicies += Number(p.policies || 0);
    totalMovement += Number(p.balanceMovement || 0);

    const row = document.createElement("tr");
    row.innerHTML =
      "<td>" + escapeHtml(formatDate(p.start)) + " &ndash; " + escapeHtml(formatDate(p.end)) + "</td>" +
      '<td class="num">' + p.policies + "</td>" +
      (hidePricing
        ? ""
        : '<td class="num ' +
          (Number(p.balanceMovement) < 0 ? "neg" : "pos") +
          '">' +
          formatSignedMoney(p.balanceMovement) +
          "</td>");
    PeriodRows.appendChild(row);
  }

  TotalPolicies.textContent = totalPolicies;
  TotalMovement.textContent = hidePricing ? "" : formatSignedMoney(totalMovement);
  StatPolicies.textContent = totalPolicies;

  renderBanner(b);
  InactivePoliciesPanel.classList.add("hidden");
  policiesDate = "";
  PoliciesDatePicker.value = "";
  syncPoliciesDateField();
  policySort = { key: "created", dir: -1 };

  EmptyState.classList.add("hidden");
  Detail.classList.remove("hidden");

  await loadPolicies();
}

BrokerSearch.addEventListener("input", renderBrokerList);

async function loadPolicies() {
  if (!selectedId) return;
  try {
    const data = await api("/brokers/" + selectedId + "/policies");
    renderPolicies(data);
    PoliciesPanel.classList.remove("hidden");
    InactivePoliciesPanel.classList.add("hidden");
  } catch (err) {
    PoliciesRows.innerHTML = "";
    const row = document.createElement("tr");
    row.innerHTML =
      '<td colspan="5" class="policies-empty">' +
      escapeHtml(err.message || t("policies.loadFailed")) +
      "</td>";
    PoliciesRows.appendChild(row);
    PoliciesTotalBalance.textContent = "";
    PoliciesPanel.classList.remove("hidden");
    InactivePoliciesPanel.classList.add("hidden");
  }
}

PoliciesBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  if (!PoliciesPanel.classList.contains("hidden")) {
    PoliciesPanel.classList.add("hidden");
    InactivePoliciesPanel.classList.add("hidden");
    return;
  }
  await loadPolicies();
});

InactivePoliciesBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  if (!InactivePoliciesPanel.classList.contains("hidden")) {
    InactivePoliciesPanel.classList.add("hidden");
    return;
  }
  try {
    const data = await api("/brokers/" + selectedId + "/inactive-policies");
    renderInactivePolicies(data);
    InactivePoliciesPanel.classList.remove("hidden");
    PoliciesPanel.classList.add("hidden");
  } catch (err) {
    InactivePoliciesRows.innerHTML = "";
    const row = document.createElement("tr");
    row.innerHTML =
      '<td class="policies-empty">' +
      escapeHtml(err.message || t("inactive.loadFailed")) +
      "</td>";
    InactivePoliciesRows.appendChild(row);
    InactivePoliciesCount.textContent = "";
    InactivePoliciesPanel.classList.remove("hidden");
    PoliciesPanel.classList.add("hidden");
  }
});

function inactiveBlancNumber(p) {
  return p.BlancNumber ?? p.Blanc ?? p.blancNumber ?? p.Number ?? p.number ?? p.id ?? p;
}

function renderInactivePolicies(data) {
  const list = Array.isArray(data)
    ? data
    : (data && (data.policies || data.inactivePolicies || data.blancs || data.inactiveBlancs)) || [];
  InactivePoliciesRows.innerHTML = "";

  if (list.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML =
      '<td class="policies-empty">' +
      escapeHtml(t("inactive.empty")) +
      "</td>";
    InactivePoliciesRows.appendChild(row);
  } else {
    for (const p of list) {
      const row = document.createElement("tr");
      row.innerHTML = "<td>" + escapeHtml(inactiveBlancNumber(p)) + "</td>";
      InactivePoliciesRows.appendChild(row);
    }
  }
  InactivePoliciesCount.textContent = t("list.inactive", { n: list.length });
}

async function load() {
  try {
    const data = await api("/brokers/biweekly");
    brokers = data.brokers || [];
    schedule = data.schedule || null;
    renderBrokerList();
    loadReport();
    loadCashInflow();
    if (brokers.length > 0) await selectBroker(brokers[0].id);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearSession();
      window.location.replace("index.html");
      return;
    }
    BrokerList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "broker-item muted";
    li.textContent = err.message || t("list.loadFailed");
    BrokerList.appendChild(li);
  }
}

// Re-render dynamic content when the language changes.
onLangChange(() => {
  applyBrokerMode();
  renderBrokerList();
  if (selectedId !== null) {
    const b = brokers.find((x) => x.id === selectedId);
    if (b) selectBroker(b.id);
  }
});

load();

// --- Account settings & admin registrations --------------------------------

const SettingsOverlay = document.getElementById("SettingsOverlay");
const SettingsBtn = document.getElementById("SettingsBtn");
const SettingsCloseBtn = document.getElementById("SettingsCloseBtn");
const PasswordForm = document.getElementById("PasswordForm");
const CurrentPassInput = document.getElementById("CurrentPassInput");
const NewPassInput = document.getElementById("NewPassInput");
const ConfirmPassInput = document.getElementById("ConfirmPassInput");
const PasswordMsg = document.getElementById("PasswordMsg");
const EmailSection = document.getElementById("EmailSection");
const EmailList = document.getElementById("EmailList");
const EmailInput = document.getElementById("EmailInput");
const EmailAddBtn = document.getElementById("EmailAddBtn");
const EmailSaveBtn = document.getElementById("EmailSaveBtn");
const EmailMsg = document.getElementById("EmailMsg");
const RegistrationsOverlay = document.getElementById("RegistrationsOverlay");
const RegistrationsBtn = document.getElementById("RegistrationsBtn");
const RegistrationsCloseBtn = document.getElementById("RegistrationsCloseBtn");
const PendingList = document.getElementById("PendingList");
const PendingMsg = document.getElementById("PendingMsg");

let settingsEmails = [];

function setMsg(el, text, isError) {
  el.textContent = text || "";
  el.className = "msg " + (isError ? "error" : "success");
  if (!text) el.className = "msg";
}

function openOverlay(el) {
  el.classList.remove("hidden");
}
function closeOverlay(el) {
  el.classList.add("hidden");
}

// --- Settings ---------------------------------------------------------------

async function openSettings() {
  setMsg(PasswordMsg, "", false);
  setMsg(EmailMsg, "", false);
  PasswordForm.reset();
  settingsEmails = [];
  renderEmailList();
  openOverlay(SettingsOverlay);
  try {
    const account = await api("/account");
    settingsEmails = account.emails || [];
    EmailSection.classList.toggle("hidden", !account.canManageEmails);
    renderEmailList();
  } catch (err) {
    settingsEmails = [];
    EmailSection.classList.add("hidden");
    setMsg(EmailMsg, err.message || t("settings.loadFailed"), true);
  }
}

function renderEmailList() {
  EmailList.innerHTML = "";
  if (settingsEmails.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("settings.emails.empty");
    EmailList.appendChild(li);
    return;
  }
  for (const email of settingsEmails) {
    const li = document.createElement("li");
    li.className = "email-item";
    const span = document.createElement("span");
    span.textContent = email;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost btn-small";
    btn.textContent = t("settings.emails.remove");
    btn.addEventListener("click", () => {
      settingsEmails = settingsEmails.filter((e) => e !== email);
      renderEmailList();
    });
    li.appendChild(span);
    li.appendChild(btn);
    EmailList.appendChild(li);
  }
}

function addEmail() {
  const email = EmailInput.value.trim();
  if (!email) return;
  EmailInput.value = "";
  if (settingsEmails.includes(email)) return;
  settingsEmails.push(email);
  renderEmailList();
}

SettingsBtn.addEventListener("click", openSettings);
SettingsCloseBtn.addEventListener("click", () => closeOverlay(SettingsOverlay));

EmailAddBtn.addEventListener("click", addEmail);
EmailInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addEmail();
  }
});

EmailSaveBtn.addEventListener("click", async () => {
  try {
    const data = await api("/account/emails", {
      method: "PUT",
      body: JSON.stringify({ emails: settingsEmails }),
    });
    settingsEmails = data.emails || [];
    renderEmailList();
    setMsg(EmailMsg, t("settings.emails.saved"), false);
  } catch (err) {
    setMsg(EmailMsg, err.message || t("settings.emails.saveFailed"), true);
  }
});

PasswordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = CurrentPassInput.value;
  const next = NewPassInput.value;
  const confirm = ConfirmPassInput.value;

  if (!current || !next) {
    setMsg(PasswordMsg, t("settings.password.required"), true);
    return;
  }
  if (next.length < 6) {
    setMsg(PasswordMsg, t("register.passwordTooShort"), true);
    return;
  }
  if (next !== confirm) {
    setMsg(PasswordMsg, t("register.passwordMismatch"), true);
    return;
  }

  try {
    await api("/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    PasswordForm.reset();
    setMsg(PasswordMsg, t("settings.password.success"), false);
  } catch (err) {
    setMsg(PasswordMsg, err.message || t("settings.password.failed"), true);
  }
});

// --- Admin pending registrations --------------------------------------------

if (role === "1" && RegistrationsBtn) {
  RegistrationsBtn.classList.remove("hidden");
}

async function openRegistrations() {
  setMsg(PendingMsg, "", false);
  openOverlay(RegistrationsOverlay);
  await loadPending();
}

async function loadPending() {
  PendingList.innerHTML = "";
  setMsg(PendingMsg, "", false);
  try {
    const data = await api("/admin/users");
    const pending = (data.users || []).filter(
      (u) => String(u.Status) === "pending"
    );
    renderPending(pending);
  } catch (err) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = err.message || t("admin.pending.loadFailed");
    PendingList.appendChild(li);
  }
}

function brokerOptions() {
  let html =
    '<option value="">' + escapeHtml(t("admin.pending.selectBroker")) + "</option>";
  for (const b of brokers) {
    html += `<option value="${b.id}">${escapeHtml(b.Name)}</option>`;
  }
  return html;
}

function renderPending(pending) {
  if (pending.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("admin.pending.empty");
    PendingList.appendChild(li);
    return;
  }

  for (const u of pending) {
    const li = document.createElement("li");
    li.className = "pending-item";

    const info = document.createElement("div");
    info.className = "pending-info";
    const name = document.createElement("div");
    name.className = "pending-name";
    name.textContent = u.Username;
    const meta = document.createElement("div");
    meta.className = "pending-meta";
    meta.textContent = [
      u.Email || "",
      u.CreatedAt ? formatDate(String(u.CreatedAt).slice(0, 10)) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    info.appendChild(name);
    info.appendChild(meta);

    const controls = document.createElement("div");
    controls.className = "pending-controls";
    const select = document.createElement("select");
    select.className = "pending-select";
    select.innerHTML = brokerOptions();
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn-primary btn-small";
    approve.textContent = t("admin.pending.approve");
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn-ghost btn-small";
    reject.textContent = t("admin.pending.reject");

    approve.addEventListener("click", async () => {
      const brokerId = select.value;
      if (!brokerId) {
        setMsg(PendingMsg, t("admin.pending.selectBroker"), true);
        return;
      }
      try {
        await api("/admin/users/" + encodeURIComponent(u.Username) + "/approve", {
          method: "POST",
          body: JSON.stringify({ brokerId: Number(brokerId) }),
        });
        setMsg(PendingMsg, t("admin.pending.approved", { name: u.Username }), false);
        await loadPending();
      } catch (err) {
        setMsg(PendingMsg, err.message || t("admin.pending.approveFailed"), true);
      }
    });

    reject.addEventListener("click", async () => {
      try {
        await api("/admin/users/" + encodeURIComponent(u.Username) + "/delete", {
          method: "POST",
        });
        setMsg(PendingMsg, t("admin.pending.rejected", { name: u.Username }), false);
        await loadPending();
      } catch (err) {
        setMsg(PendingMsg, err.message || t("admin.pending.rejectFailed"), true);
      }
    });

    controls.appendChild(select);
    controls.appendChild(approve);
    controls.appendChild(reject);
    li.appendChild(info);
    li.appendChild(controls);
    PendingList.appendChild(li);
  }
}

RegistrationsBtn.addEventListener("click", openRegistrations);
RegistrationsCloseBtn.addEventListener("click", () =>
  closeOverlay(RegistrationsOverlay)
);

// --- Main broker: sub-brokers (underlings) + per-broker pricing -------------

const SubBrokersPanel = document.getElementById("SubBrokersPanel");
const UnderlingsList = document.getElementById("UnderlingsList");
const UnderlingFrom = document.getElementById("UnderlingFrom");
const UnderlingTo = document.getElementById("UnderlingTo");
const UnderlingClearBtn = document.getElementById("UnderlingClearBtn");
const UnderlingsTotalBalance = document.getElementById("UnderlingsTotalBalance");
const PricingOverlay = document.getElementById("PricingOverlay");
const PricingTitle = document.getElementById("PricingTitle");
const PricingMeta = document.getElementById("PricingMeta");
const PricingTable = document.getElementById("PricingTable");
const PricingSaveBtn = document.getElementById("PricingSaveBtn");
const PricingMsg = document.getElementById("PricingMsg");
const PricingCloseBtn = document.getElementById("PricingCloseBtn");

const myBrokerId = getBrokerId() ? Number(getBrokerId()) : null;
let pricingTarget = null; // { id, name }
let pricingData = null;   // { vehicleType: { duration: price } }

function underlingDateParams() {
  const from = UnderlingFrom ? UnderlingFrom.value.trim() : "";
  const to = UnderlingTo ? UnderlingTo.value.trim() : "";
  const qs = [];
  if (from) qs.push("from=" + encodeURIComponent(from));
  if (to) qs.push("to=" + encodeURIComponent(to));
  return qs.length ? "?" + qs.join("&") : "";
}

async function loadUnderlings() {
  if (!isBroker || !myBrokerId || !SubBrokersPanel) return;
  try {
    const data = await api(
      "/brokers/" + myBrokerId + "/underlings" + underlingDateParams()
    );
    const list = data.underlings || [];
    if (list.length === 0) {
      SubBrokersPanel.classList.add("hidden");
      return;
    }
    SubBrokersPanel.classList.remove("hidden");
    renderUnderlings(list, data.totalBalance);
  } catch (err) {
    if (err.status === 403) {
      SubBrokersPanel.classList.add("hidden");
      return;
    }
    if (UnderlingsTotalBalance) {
      UnderlingsTotalBalance.textContent = "";
      UnderlingsTotalBalance.classList.add("hidden");
    }
    UnderlingsList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = err.message || t("underlings.loadFailed");
    UnderlingsList.appendChild(li);
    SubBrokersPanel.classList.remove("hidden");
  }
}

function underlingExcelName(name) {
  return String(name || "sub-broker")
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function exportUnderlingExcel(u, btn) {
  const original = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const data = await api(
      "/brokers/" + u.id + "/policies" + underlingDateParams()
    );
    const policies = data.policies || [];
    const hidePricing =
      data.hidePricing !== undefined
        ? Boolean(data.hidePricing)
        : isPricingHidden(u);
    downloadExcel(
      buildPoliciesExcel(policies, hidePricing),
      "policies-" + (underlingExcelName(u.Name) || u.id) + ".xls"
    );
  } catch (err) {
    alert(err.message || t("policies.loadFailed"));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

function renderUnderlings(list, serverTotalBalance) {
  UnderlingsList.innerHTML = "";
  let sumTotal = 0;
  let anyVisible = false;
  for (const u of list) {
    const li = document.createElement("li");
    li.className = "underling-item";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "underling-name";
    name.textContent = u.Name;
    name.title = t("pricing.title");
    name.addEventListener("click", () => openPricing(u.id, u.Name));

    const hidden = isPricingHidden(u);
    if (!hidden) {
      anyVisible = true;
      sumTotal += Number(u.totalPrice ?? u.totalBalance ?? 0);
    }

    const meta = document.createElement("span");
    meta.className = "underling-meta";
    meta.textContent = hidden
      ? t("underlings.policiesCount", { n: u.policyCount })
      : t("underlings.policiesCount", { n: u.policyCount }) +
        " · " +
        formatMoney(u.totalPrice ?? u.totalBalance ?? 0);

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn-ghost btn-small underling-export";
    exportBtn.textContent = t("policies.export");
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      exportUnderlingExcel(u, exportBtn);
    });

    const actions = document.createElement("div");
    actions.className = "underling-actions";
    actions.appendChild(meta);
    actions.appendChild(exportBtn);

    li.appendChild(name);
    li.appendChild(actions);
    UnderlingsList.appendChild(li);
  }

  if (UnderlingsTotalBalance) {
    if (!anyVisible) {
      UnderlingsTotalBalance.textContent = "";
      UnderlingsTotalBalance.classList.add("hidden");
    } else {
      const total =
        serverTotalBalance !== undefined && serverTotalBalance !== null
          ? Number(serverTotalBalance)
          : sumTotal;
      UnderlingsTotalBalance.classList.remove("hidden");
      UnderlingsTotalBalance.textContent =
        t("policies.totalBalance") + ": " + formatMoney(total);
    }
  }
}

UnderlingFrom.addEventListener("change", loadUnderlings);
UnderlingTo.addEventListener("change", loadUnderlings);
UnderlingClearBtn.addEventListener("click", () => {
  UnderlingFrom.value = "";
  UnderlingTo.value = "";
  loadUnderlings();
});

// --- Per-broker pricing modal ---------------------------------------------

function buildPricingGrid(pricing) {
  const types = Object.keys(pricing || {}).sort();
  const durations = new Set();
  for (const t of types) {
    for (const d of Object.keys(pricing[t] || {})) durations.add(Number(d));
  }
  return { types, durations: Array.from(durations).sort((a, b) => a - b) };
}

function renderPricingGrid() {
  const pricing = pricingData || {};
  const { types, durations } = buildPricingGrid(pricing);

  PricingTable.innerHTML = "";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const thType = document.createElement("th");
  thType.textContent = t("pricing.vehicleType");
  hr.appendChild(thType);
  for (const d of durations) {
    const th = document.createElement("th");
    th.className = "num";
    th.textContent = d;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  PricingTable.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const typeName of types) {
    const tr = document.createElement("tr");
    const tdType = document.createElement("td");
    tdType.textContent = typeName;
    tr.appendChild(tdType);
    for (const d of durations) {
      const td = document.createElement("td");
      td.className = "num";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.className = "pricing-input";
      input.dataset.type = typeName;
      input.dataset.duration = String(d);
      const val = pricing[typeName] && pricing[typeName][String(d)];
      if (val !== undefined && val !== null && val !== "") input.value = val;
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  PricingTable.appendChild(tbody);
}

async function openPricing(brokerId, brokerName) {
  pricingTarget = { id: brokerId, name: brokerName };
  PricingTitle.textContent = t("pricing.title") + ": " + brokerName;
  PricingMeta.textContent = "";
  PricingMsg.textContent = "";
  PricingMsg.className = "msg";
  openOverlay(PricingOverlay);
  try {
    const data = await api("/brokers/" + brokerId + "/pricing");
    pricingData = data.pricing || {};
    if (data.inherited && data.sourceBrokerName) {
      PricingMeta.textContent = t("pricing.inherited", {
        name: data.sourceBrokerName,
      });
    }
    renderPricingGrid();
  } catch (err) {
    PricingTable.innerHTML = "";
    PricingMeta.textContent = "";
    setMsg(PricingMsg, err.message || t("pricing.loadFailed"), true);
  }
}

function collectPricing() {
  const pricing = {};
  PricingTable.querySelectorAll("input.pricing-input").forEach((input) => {
    const typeName = input.dataset.type;
    const duration = input.dataset.duration;
    const raw = input.value.trim();
    if (raw === "") return;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return;
    if (!pricing[typeName]) pricing[typeName] = {};
    pricing[typeName][duration] = num;
  });
  return pricing;
}

PricingSaveBtn.addEventListener("click", async () => {
  if (!pricingTarget) return;
  try {
    const data = await api("/brokers/" + pricingTarget.id + "/pricing", {
      method: "PUT",
      body: JSON.stringify({ pricing: collectPricing() }),
    });
    pricingData = data.pricing || {};
    PricingMeta.textContent = "";
    setMsg(PricingMsg, t("pricing.saved"), false);
    renderPricingGrid();
    if (isBroker) await loadUnderlings();
    await load();
  } catch (err) {
    setMsg(PricingMsg, err.message || t("pricing.saveFailed"), true);
  }
});

PricingCloseBtn.addEventListener("click", () => closeOverlay(PricingOverlay));

onLangChange(() => {
  if (isBroker) loadUnderlings();
});

if (isBroker) loadUnderlings();

"use strict";

// The broker dashboard is for admins (1), workers (2), and broker-linked
// clients (3). A broker sees only their own broker (enforced by the server).
const role = getRole();
const isBroker = role === "3" && !!getBrokerId();
if (!getToken() || (role !== "1" && role !== "2" && !isBroker)) {
  clearSession();
  window.location.replace("index3.html");
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
const PoliciesTotalBalance = document.getElementById("PoliciesTotalBalance");

UserName.textContent = getUsername();
LogoutBtn.addEventListener("click", () => {
  clearSession();
  window.location.replace("index3.html");
});

let brokers = [];
let selectedId = null;
let schedule = null;

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
    sub.textContent =
      formatMoney(b.CashBalance) + " · " + t("list.inactive", { n: b.InactivePolicies ?? 0 });

    li.appendChild(name);
    li.appendChild(sub);
    li.addEventListener("click", () => selectBroker(b.id));
    BrokerList.appendChild(li);
  }
}

function renderBanner(b) {
  if (!PaymentBanner) return;
  if (!schedule) {
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

// Local calendar day of a policy's creation date, as "YYYY-MM-DD".
function policyDay(p) {
  const d = toDate(p.CreationDate);
  return d ? localDateString(d) : "";
}

function filteredPolicies() {
  if (!policiesDate) return policiesData.slice();
  return policiesData.filter((p) => policyDay(p) === policiesDate);
}

const DATE_LOCALES = { en: "en-GB", bg: "bg-BG", tr: "tr-TR" };

// Format a YYYY-MM-DD filter value into the language-appropriate short date.
function formatPoliciesDateValue(value) {
  if (!value) return "";
  const d = toDate(value);
  if (!d) return String(value);
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[getLang()] || "en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
  } catch {
    return formatDate(d);
  }
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
  policiesData = data.policies || [];
  PoliciesSince.textContent = data.schedule
    ? t("policies.since", { date: formatDate(data.schedule.periodStart) })
    : "";
  renderPolicyTable();
}

function renderPolicyTable() {
  PoliciesRows.innerHTML = "";
  const policies = sortedPolicies();
  for (const p of policies) {
    const row = document.createElement("tr");
    row.innerHTML =
      "<td>" + escapeHtml(p.PolicyNumber) + "</td>" +
      "<td>" + escapeHtml(p.BlancNumber) + "</td>" +
      '<td class="num">' + formatMoney(p.Price) + "</td>" +
      "<td>" + escapeHtml(p.CurrencyType) + "</td>" +
      "<td>" + escapeHtml(formatDate(p.CreationDate)) + "</td>";
    PoliciesRows.appendChild(row);
  }
  if (policies.length === 0) {
    const emptyMessage = policiesDate ? t("policies.emptyForDate") : t("policies.empty");
    const row = document.createElement("tr");
    row.innerHTML =
      '<td colspan="5" class="policies-empty">' +
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

async function selectBroker(id) {
  selectedId = id;
  renderBrokerList();

  const b = brokers.find((x) => x.id === id);
  if (!b) return;

  DetailName.textContent = b.Name;
  StatBalance.textContent = formatMoney(b.CashBalance);
  StatInactive.textContent = b.InactivePolicies ?? 0;

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
      '<td class="num ' +
      (Number(p.balanceMovement) < 0 ? "neg" : "pos") +
      '">' +
      formatSignedMoney(p.balanceMovement) +
      "</td>";
    PeriodRows.appendChild(row);
  }

  TotalPolicies.textContent = totalPolicies;
  TotalMovement.textContent = formatSignedMoney(totalMovement);
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
    if (brokers.length > 0) await selectBroker(brokers[0].id);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearSession();
      window.location.replace("index3.html");
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

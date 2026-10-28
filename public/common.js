"use strict";
// Shared helpers for the Insurance website (broker/admin dashboard).
//
// The InsuranceServer API base. The production server is the default; for
// local development open the site as  index.html?api=http://127.0.0.1:5501
// so the same page talks to a locally running InsuranceServer.

const API_BASE =
  new URLSearchParams(window.location.search).get("api") ||
  "https://lavender-quail-935384.hostingersite.com";

const ROLE_LABELS = { "1": "Admin", "2": "Worker", "3": "Client" };

// --- Internationalisation helpers (translation strings live in i18n.js) ----
function getLang() {
  const lang = localStorage.getItem("lang");
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

function t(key, vars) {
  const lang = getLang();
  let str = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key] ?? key;
  if (vars) {
    str = String(str).replace(/\{(\w+)\}/g, (m, k) =>
      vars[k] !== undefined ? String(vars[k]) : m
    );
  }
  return str;
}

const langChangeListeners = new Set();
function onLangChange(fn) {
  langChangeListeners.add(fn);
  return () => langChangeListeners.delete(fn);
}

function applyI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  document.querySelectorAll("[data-lang]").forEach((el) => {
    const active = el.getAttribute("data-lang") === lang;
    el.classList.toggle("active", active);
    el.setAttribute("aria-pressed", String(active));
  });
}

function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = "en";
  localStorage.setItem("lang", lang);
  applyI18n();
  for (const fn of langChangeListeners) {
    try {
      fn(lang);
    } catch (err) {
      console.error(err);
    }
  }
}

function setupLangSwitcher() {
  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.getAttribute("data-lang")));
  });
}

function getToken() {
  return localStorage.getItem("token") || "";
}
function getUsername() {
  return localStorage.getItem("username") || "";
}
function getRole() {
  return localStorage.getItem("role") || "";
}

function setSession(data) {
  localStorage.setItem("token", data.token || "");
  localStorage.setItem("username", data.username || "");
  localStorage.setItem("role", String(data.role || ""));
  if (data.brokerId !== undefined && data.brokerId !== null) {
    localStorage.setItem("brokerId", String(data.brokerId));
  } else {
    localStorage.removeItem("brokerId");
  }
}

function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  localStorage.removeItem("role");
  localStorage.removeItem("brokerId");
}

function getBrokerId() {
  return localStorage.getItem("brokerId") || "";
}

// Generic authenticated fetch wrapper against the InsuranceServer API.
//
// Idempotent requests (GET) are retried a few times with a per-attempt timeout
// so a transient network blip or a server 5xx (e.g. a hosting maintenance
// window) recovers automatically instead of failing the whole page. Mutating
// requests are never retried because a retry could apply the change twice.
const API_TIMEOUT_MS = 20000;
const API_MAX_ATTEMPTS = 3;

function apiIsRetryable(method) {
  return String(method || "GET").toUpperCase() === "GET";
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retryable = apiIsRetryable(method);
  const attempts = retryable ? API_MAX_ATTEMPTS : 1;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 700 * Math.pow(2, attempt - 1)));
    }

    const headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(
        API_BASE + path,
        Object.assign({}, options, { headers, signal: controller.signal })
      );
    } catch (err) {
      clearTimeout(timer);
      if (retryable && (err.name === "AbortError" || err instanceof TypeError)) {
        lastError = err;
        continue;
      }
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const message =
        (data && (data.error || data.message)) ||
        "Request failed (" + res.status + ")";
      if (retryable && (res.status === 429 || res.status >= 500)) {
        lastError = new Error(message);
        lastError.status = res.status;
        continue;
      }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  throw lastError || new Error("Request failed");
}

function formatMoney(n) {
  // Whole numbers only — the site works with full amounts, no decimals.
  return Math.round(Number(n || 0)).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatSignedMoney(n) {
  const v = Number(n || 0);
  return (v > 0 ? "+" : "") + formatMoney(v);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // Date-only strings ("YYYY-MM-DD") are parsed as UTC by `new Date`, which
  // can shift the day in some timezones. DATETIME strings (the client's local
  // wall-clock, e.g. "YYYY-MM-DD HH:MM:SS", with a space or "T" separator and
  // an optional trailing timezone) must also be parsed from their explicit
  // Y/M/D components, otherwise a trailing "Z" or the browser's own timezone
  // would shift the calendar day. Build the date from the matched components.
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]) || 0,
      Number(m[5]) || 0,
      Number(m[6]) || 0
    );
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(v) {
  const d = toDate(v);
  if (!d) return String(v || "");
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + " - " + p(d.getMonth() + 1) + " - " + String(d.getFullYear()).slice(-2);
}

const MONTH_NAMES = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  bg: ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"],
  tr: ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
};

function monthName(index) {
  const names = MONTH_NAMES[getLang()] || MONTH_NAMES.en;
  return names[index];
}

function ordinal(n) {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// "18th of October 2026" (en), "18 октомври 2026" (bg), "18 Ekim 2026" (tr)
function formatDateLong(v) {
  const d = toDate(v);
  if (!d) return String(v || "");
  const lang = getLang();
  const day = lang === "en" ? d.getDate() + ordinal(d.getDate()) : d.getDate();
  const month = monthName(d.getMonth());
  return lang === "en"
    ? day + " of " + month + " " + d.getFullYear()
    : day + " " + month + " " + d.getFullYear();
}

// "16 to 18th of October 2026" (en), "16 – 18 октомври 2026" (bg), "16 – 18 Ekim 2026" (tr)
function formatDateRangeHuman(start, end) {
  const ds = toDate(start);
  const de = toDate(end);
  if (!ds || !de) return formatDate(start) + " – " + formatDate(end);
  const lang = getLang();
  if (ds.getFullYear() === de.getFullYear() && ds.getMonth() === de.getMonth()) {
    const startDay = ds.getDate();
    const endDay = lang === "en" ? de.getDate() + ordinal(de.getDate()) : de.getDate();
    const month = monthName(de.getMonth());
    if (lang === "en") {
      return startDay + " to " + endDay + " of " + month + " " + de.getFullYear();
    }
    return startDay + " – " + endDay + " " + month + " " + de.getFullYear();
  }
  return formatDateLong(ds) + " – " + formatDateLong(de);
}

setupLangSwitcher();
applyI18n();

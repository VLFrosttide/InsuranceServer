"use strict";

const LoginForm = document.getElementById("LoginForm");
const UsernameInput = document.getElementById("UsernameInput");
const PassInput = document.getElementById("PassInput");
const RememberInput = document.getElementById("RememberInput");
const DisplayMsg = document.getElementById("DisplayMsg");

const REMEMBER_USER_KEY = "rememberUsername";
const REMEMBER_PASS_KEY = "rememberPassword";

function setMessage(text, isError) {
  if (!DisplayMsg) return;
  DisplayMsg.textContent = text || "";
  DisplayMsg.className = "msg " + (isError ? "error" : "success");
  if (!text) DisplayMsg.className = "msg";
}

// Pre-fill the form from any previously saved credentials.
function loadRemembered() {
  const username = localStorage.getItem(REMEMBER_USER_KEY);
  const password = localStorage.getItem(REMEMBER_PASS_KEY);
  if (username !== null) {
    UsernameInput.value = username;
    RememberInput.checked = true;
  }
  if (password !== null) {
    PassInput.value = password;
  }
}

// Save (or clear) the credentials depending on the checkbox. Note: the
// password is stored in plain text in localStorage, so use this only on
// trusted devices.
function saveRemembered(username, password) {
  if (RememberInput && RememberInput.checked) {
    localStorage.setItem(REMEMBER_USER_KEY, username);
    localStorage.setItem(REMEMBER_PASS_KEY, password);
  } else {
    localStorage.removeItem(REMEMBER_USER_KEY);
    localStorage.removeItem(REMEMBER_PASS_KEY);
  }
}

// Retry helper for the login POST. Login is idempotent from the client's point
// of view (the server deletes any prior token before issuing a new one), so a
// transient network blip or a server 5xx auto-recovers instead of failing the
// form with a bare "Server Error".
const LOGIN_TIMEOUT_MS = 15000;
const LOGIN_MAX_ATTEMPTS = 3;

async function loginFetch(username, password) {
  let lastNetworkError = null;
  for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      setMessage(t("login.retrying"), false);
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const res = await fetch(API_BASE + "/logme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError" || err instanceof TypeError) {
        lastNetworkError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastNetworkError || new Error("Login request failed");
}

async function doLogin() {
  const username = UsernameInput.value.trim();
  const password = PassInput.value;

  if (!username || !password) {
    setMessage(t("login.enterCredentials"), true);
    return;
  }

  try {
    const { res, data } = await loginFetch(username, password);

    if (!res.ok) {
      setMessage(data.error || t("login.failed"), true);
      return;
    }

    setSession(data);
    const role = String(data.role || "");
    const isBroker = role === "3" && !!data.brokerId;

    // The portal is for brokers and admins; workers (2) share the broker view.
    if (role === "1" || role === "2" || isBroker) {
      saveRemembered(username, password);
      const apiParam = new URLSearchParams(window.location.search).get("api");
      window.location.href =
        "dashboard.html" +
        (apiParam ? "?api=" + encodeURIComponent(apiParam) : "");
    } else {
      setMessage(t("login.restricted"), true);
      clearSession();
    }
  } catch (err) {
    console.error(err);
    setMessage(t("server.error"), true);
  }
}

LoginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin();
});

loadRemembered();

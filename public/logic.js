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

async function doLogin() {
  const username = UsernameInput.value.trim();
  const password = PassInput.value;

  if (!username || !password) {
    setMessage(t("login.enterCredentials"), true);
    return;
  }

  try {
    const res = await fetch(API_BASE + "/logme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json().catch(() => ({}));

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

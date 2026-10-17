"use strict";

const RegisterForm = document.getElementById("RegisterForm");
const RegUsernameInput = document.getElementById("RegUsernameInput");
const RegEmailInput = document.getElementById("RegEmailInput");
const RegPassInput = document.getElementById("RegPassInput");
const RegConfirmInput = document.getElementById("RegConfirmInput");
const RegMsg = document.getElementById("RegMsg");

function setMessage(text, isError) {
  if (!RegMsg) return;
  RegMsg.textContent = text || "";
  RegMsg.className = "msg " + (isError ? "error" : "success");
  if (!text) RegMsg.className = "msg";
}

async function doRegister() {
  const username = RegUsernameInput.value.trim();
  const email = RegEmailInput.value.trim();
  const password = RegPassInput.value;
  const confirm = RegConfirmInput.value;

  if (!username || !password) {
    setMessage(t("register.enterCredentials"), true);
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMessage(t("register.enterEmail"), true);
    return;
  }
  if (password.length < 6) {
    setMessage(t("register.passwordTooShort"), true);
    return;
  }
  if (password !== confirm) {
    setMessage(t("register.passwordMismatch"), true);
    return;
  }

  try {
    const res = await fetch(API_BASE + "/userreg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setMessage(data.error || t("register.failed"), true);
      return;
    }

    setMessage(t("register.success"), false);
    RegisterForm.reset();
  } catch (err) {
    console.error(err);
    setMessage(t("server.error"), true);
  }
}

RegisterForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doRegister();
});

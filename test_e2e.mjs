"use strict";
// End-to-end smoke test for InsuranceServer.
// Spawns `main.js`, waits for the listen message, then exercises the REST API
// and the WebSocket, printing PASS/FAIL for each check.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const BASE = "http://127.0.0.1:5501";
const WS_URL = "ws://127.0.0.1:5501/ws";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file=.env", "main.js"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DISABLE_GMAIL: "1" },
    });
    let out = "";
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for server. Output:\n" + out));
    }, 25000);

    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("Server listening") && !child._ready) {
        child._ready = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => {
      if (!child._ready) {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code}). Output:\n` + out));
      }
    });
  });
}

function wsAuth(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("WS auth timeout")), 5000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.on("error", reject);
  });
}

async function main() {
  console.log("Starting server...");
  const child = await startServer();
  console.log("Server is up.\n");

  try {
    // Health
    let r = await req("GET", "/health");
    check("GET /health", r.status === 200 && r.data.status === "ok");

    // Login (admin)
    r = await req("POST", "/logme", {
      username: "admin",
      password: "AdminPass123",
    });
    check(
      "POST /logme admin",
      r.status === 200 && r.data.token,
      JSON.stringify(r.data)
    );
    const adminToken = r.data.token;

    // Login (worker) - list4e
    r = await req("POST", "/logme", {
      username: "list4e",
      password: "Pedese50",
    });
    check(
      "POST /logme worker",
      r.status === 200 && r.data.role === "2",
      JSON.stringify(r.data)
    );
    const workerToken = r.data.token;

    // Login (client)
    r = await req("POST", "/logme", {
      username: "client",
      password: "ClientPass123",
    });
    check(
      "POST /logme client",
      r.status === 200 && r.data.role === "3",
      JSON.stringify(r.data)
    );
    const clientToken = r.data.token;

    // Wrong password
    r = await req("POST", "/logme", { username: "admin", password: "wrong" });
    check("POST /logme bad password -> 401", r.status === 401);

    // Unknown user
    r = await req("POST", "/logme", { username: "nobody", password: "x" });
    check("POST /logme unknown user -> 401", r.status === 401);

    // Registration (unique per run so the test stays repeatable)
    const regUser = `newclient_${Date.now()}`;
    r = await req("POST", "/userreg", {
      username: regUser,
      password: "secret123",
    });
    check("POST /userreg new client", r.status === 201, JSON.stringify(r.data));

    // Duplicate registration
    r = await req("POST", "/userreg", {
      username: regUser,
      password: "secret123",
    });
    check("POST /userreg duplicate -> 409", r.status === 409);

    // Admin endpoints
    r = await req("GET", "/admin/users", null, adminToken);
    check("GET /admin/users", r.status === 200 && Array.isArray(r.data.users));
    r = await req("GET", "/admin/stats", null, adminToken);
    check("GET /admin/stats", r.status === 200 && r.data.stats);
    r = await req("GET", "/admin/insurances", null, adminToken);
    check(
      "GET /admin/insurances",
      r.status === 200 && Array.isArray(r.data.insurances)
    );

    // Role isolation: worker should NOT access admin
    r = await req("GET", "/admin/users", null, workerToken);
    check(
      "Worker blocked from /admin/users -> 403",
      r.status === 403 || r.status === 401
    );

    // Worker endpoints
    r = await req("GET", "/worker/tasks", null, workerToken);
    check("GET /worker/tasks", r.status === 200 && Array.isArray(r.data.tasks));
    r = await req("GET", "/worker/clients", null, workerToken);
    check(
      "GET /worker/clients",
      r.status === 200 && Array.isArray(r.data.clients)
    );

    // Worker balance update
    r = await req(
      "POST",
      "/worker/clients/balance",
      { username: "client", balance: 777 },
      workerToken
    );
    check(
      "POST /worker/clients/balance",
      r.status === 200,
      JSON.stringify(r.data)
    );

    // Worker creates insurance
    r = await req(
      "POST",
      "/worker/insurances",
      {
        DKN: "TEST123",
        PolicyNumber: "BG/TEST/1",
        BlancNumber: `B${Date.now()}`,
        Duration: "3 месеца",
        BrokerCode: "9.9",
        Branch: "ГКПП Лесово",
        Otomobil: "Otomobil",
        Price: "120",
        CurrencyType: "EUR",
        ClientName: "Test Client",
        ClientAdress: "Test Address",
        ChassisNumber: "CHASSIS123",
        VehicleBrand: "Opel",
        Cash: "true",
      },
      workerToken
    );
    check("POST /worker/insurances", r.status === 201, JSON.stringify(r.data));

    // Duplicate insurance
    const dupBlanc = `DUP${Date.now()}`;
    r = await req(
      "POST",
      "/worker/insurances",
      {
        BlancNumber: dupBlanc,
        ClientName: "Test Client",
      },
      workerToken
    );
    const dupStatus = r.status;
    r = await req(
      "POST",
      "/worker/insurances",
      {
        BlancNumber: dupBlanc,
        ClientName: "Test Client",
      },
      workerToken
    );
    check(
      "POST /worker/insurances duplicate -> 409",
      dupStatus === 201 && r.status === 409
    );

    // Client endpoints
    r = await req("GET", "/client/profile", null, clientToken);
    check("GET /client/profile", r.status === 200 && r.data.profile);
    r = await req("GET", "/client/insurances", null, clientToken);
    check(
      "GET /client/insurances",
      r.status === 200 && Array.isArray(r.data.insurances)
    );

    // Client blocked from worker
    r = await req("GET", "/worker/tasks", null, clientToken);
    check(
      "Client blocked from /worker/tasks -> 403",
      r.status === 403 || r.status === 401
    );

    // Missing token
    r = await req("GET", "/admin/users");
    check("GET /admin/users without token -> 401", r.status === 401);

    // WebSocket auth
    const wsMsg = await wsAuth(workerToken);
    check(
      "WebSocket auth",
      wsMsg.type === "auth_ok" && wsMsg.username === "list4e",
      JSON.stringify(wsMsg)
    );

    // WebSocket invalid token
    const wsBad = await wsAuth("BOGUS");
    check("WebSocket bad token -> auth_error", wsBad.type === "auth_error");
  } catch (err) {
    failed++;
    console.log("  ERROR " + err.stack || err.message);
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    child.kill();
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

main();

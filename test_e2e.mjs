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

    // Login (worker)
    r = await req("POST", "/logme", {
      username: "worker",
      password: "WorkerPass123",
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

    // Current cash (roles 1 and 2 only). Uses own test values, not DB data.
    r = await req("GET", "/currentcash", null, workerToken);
    check(
      "GET /currentcash (worker)",
      r.status === 200 && typeof r.data.currentCash === "number",
      JSON.stringify(r.data)
    );

    // Worker can increase current cash.
    r = await req(
      "POST",
      "/currentcash/increase",
      { amount: 55.5, reason: "test increase" },
      workerToken
    );
    check(
      "POST /currentcash/increase (worker)",
      r.status === 201 && r.data.amount === 55.5,
      JSON.stringify(r.data)
    );

    // Worker can reduce current cash.
    r = await req(
      "POST",
      "/currentcash/reduce",
      { amount: 5.5, reason: "test reduce" },
      workerToken
    );
    check(
      "POST /currentcash/reduce (worker)",
      r.status === 201 && r.data.amount === 5.5,
      JSON.stringify(r.data)
    );

    // Reducing more than the available current cash is rejected.
    r = await req(
      "POST",
      "/currentcash/reduce",
      { amount: 999999999, reason: "too much" },
      workerToken
    );
    check(
      "POST /currentcash/reduce over balance -> 400",
      r.status === 400,
      JSON.stringify(r.data)
    );

    // Missing reason is rejected.
    r = await req("POST", "/currentcash/increase", { amount: 10 }, workerToken);
    check(
      "POST /currentcash/increase without reason -> 400",
      r.status === 400,
      JSON.stringify(r.data)
    );

    // Worker can reset current cash; the endpoint records the kept amount.
    r = await req("POST", "/currentcash/reset", null, workerToken);
    check(
      "POST /currentcash/reset (worker)",
      r.status === 200 && typeof r.data.keptAmount === "number",
      JSON.stringify(r.data)
    );

    // After reset the balance is 0 and the reset is recorded.
    r = await req("GET", "/currentcash", null, workerToken);
    check(
      "GET /currentcash after reset -> 0 with reset record",
      r.status === 200 &&
        r.data.currentCash === 0 &&
        Array.isArray(r.data.resets) &&
        r.data.resets.length >= 1,
      JSON.stringify(r.data)
    );

    // Client (role 3) cannot reset current cash.
    r = await req("POST", "/currentcash/reset", null, clientToken);
    check(
      "Client blocked from /currentcash/reset -> 403",
      r.status === 403 || r.status === 401
    );

    // Admin (role 1) can also read current cash.
    r = await req("GET", "/currentcash", null, adminToken);
    check(
      "GET /currentcash (admin)",
      r.status === 200 && typeof r.data.currentCash === "number",
      JSON.stringify(r.data)
    );

    // Client (role 3) cannot interact with current cash.
    r = await req("GET", "/currentcash", null, clientToken);
    check(
      "Client blocked from /currentcash -> 403",
      r.status === 403 || r.status === 401
    );

    // Broker balance (roles 1 and 2 only). Uses own test values, not DB data.
    r = await req("GET", "/brokers", null, workerToken);
    check(
      "GET /brokers (worker)",
      r.status === 200 && Array.isArray(r.data.brokers),
      JSON.stringify(r.data)
    );
    const brokersList = r.data.brokers || [];
    const demoBroker =
      brokersList.find((b) => b.Name === "Demo Broker") || brokersList[0];
    const brokerId = demoBroker ? demoBroker.id : null;
    check(
      "Broker exists with id",
      Number.isInteger(brokerId),
      JSON.stringify(demoBroker)
    );

    // Worker can increase a broker balance.
    r = await req(
      "POST",
      `/brokers/${brokerId}/increase`,
      { amount: 100 },
      workerToken
    );
    check(
      "POST /brokers/:id/increase (worker)",
      r.status === 200 && r.data.amount === 100,
      JSON.stringify(r.data)
    );

    // Worker can reduce a broker balance (may go negative).
    r = await req(
      "POST",
      `/brokers/${brokerId}/reduce`,
      { amount: 200 },
      workerToken
    );
    check(
      "POST /brokers/:id/reduce (worker)",
      r.status === 200 && r.data.amount === 200,
      JSON.stringify(r.data)
    );

    // Admin (role 1) can also list brokers.
    r = await req("GET", "/brokers", null, adminToken);
    check(
      "GET /brokers (admin)",
      r.status === 200 && Array.isArray(r.data.brokers),
      JSON.stringify(r.data)
    );

    // Client (role 3) cannot interact with brokers.
    r = await req("GET", "/brokers", null, clientToken);
    check(
      "Client blocked from /brokers -> 403",
      r.status === 403 || r.status === 401
    );

    // Creating insurance reduces the broker balance (price × Percentage/100)
    // and decrements InactivePolicies. Use a unique blanc number.
    // Seed broker has Percentage = 10 and a policy range 100..500, so a blanc
    // inside that range resolves to it.
    const brokerBefore = await req(
      "GET",
      `/brokers/${brokerId}`,
      null,
      workerToken
    );
    const beforeBalance = Number(brokerBefore.data.broker.CashBalance);
    const beforeInactive = Number(brokerBefore.data.broker.InactivePolicies);

    // Use a unique numeric blanc inside Demo Broker's policy range
    // (100..500) so it resolves to that broker.
    const brokerInsuranceBlanc = String((Date.now() % 900000) + 100000);
    r = await req(
      "POST",
      "/worker/insurances",
      {
        BlancNumber: brokerInsuranceBlanc,
        Price: "500",
        ClientName: "Broker Test Client",
      },
      workerToken
    );
    check(
      "POST /worker/insurances (broker) -> 201",
      r.status === 201,
      JSON.stringify(r.data)
    );

    const brokerAfter = await req(
      "GET",
      `/brokers/${brokerId}`,
      null,
      workerToken
    );
    const afterBalance = Number(brokerAfter.data.broker.CashBalance);
    const afterInactive = Number(brokerAfter.data.broker.InactivePolicies);
    // price 500 × 10% = 50
    check(
      "Broker balance decreased by price × Percentage/100",
      Math.abs(beforeBalance - afterBalance - 50) < 0.01,
      `${beforeBalance} -> ${afterBalance}`
    );
    check(
      "Broker InactivePolicies decremented by 1",
      beforeInactive - afterInactive === 1,
      `${beforeInactive} -> ${afterInactive}`
    );

    // Card balance: a policy with PaymentType = Card increments CardBalance
    // instead of current cash. Measure both balances before/after to verify
    // the split.
    const cashBeforeCard = (await req("GET", "/currentcash", null, workerToken))
      .data.currentCash;
    const cardBefore = (await req("GET", "/cardpayments", null, workerToken))
      .data.cardBalance;

    // Cash = true -> current cash increases, card payments unchanged.
    r = await req(
      "POST",
      "/worker/insurances",
      {
        BlancNumber: `CASH${Date.now()}`,
        ClientName: "Cash Client",
        Price: "300",
        Cash: "true",
      },
      workerToken
    );
    check(
      "POST /worker/insurances (Cash=true) -> 201",
      r.status === 201,
      JSON.stringify(r.data)
    );
    let cashNow = (await req("GET", "/currentcash", null, workerToken)).data
      .currentCash;
    let cardNow = (await req("GET", "/cardpayments", null, workerToken)).data
      .cardBalance;
    check(
      "Cash=true increases current cash by price",
      Math.abs(cashNow - cashBeforeCard - 300) < 0.01,
      `${cashBeforeCard} -> ${cashNow}`
    );
    check(
      "Cash=true leaves card payments unchanged",
      Math.abs(cardNow - cardBefore) < 0.01,
      `${cardBefore} -> ${cardNow}`
    );

    // Cash = false -> card payments increase, current cash unchanged.
    r = await req(
      "POST",
      "/worker/insurances",
      {
        BlancNumber: `CARD${Date.now()}`,
        ClientName: "Card Client",
        Price: "125",
        Cash: "false",
      },
      workerToken
    );
    check(
      "POST /worker/insurances (Cash=false) -> 201",
      r.status === 201,
      JSON.stringify(r.data)
    );
    const cashAfterCard = (await req("GET", "/currentcash", null, workerToken))
      .data.currentCash;
    const cardAfter = (await req("GET", "/cardpayments", null, workerToken))
      .data.cardBalance;
    check(
      "Cash=false increases card payments by price",
      Math.abs(cardAfter - cardNow - 125) < 0.01,
      `${cardNow} -> ${cardAfter}`
    );
    check(
      "Cash=false leaves current cash unchanged",
      Math.abs(cashAfterCard - cashNow) < 0.01,
      `${cashNow} -> ${cashAfterCard}`
    );

    // GET /cardpayments returns the current card balance.
    r = await req("GET", "/cardpayments", null, workerToken);
    check(
      "GET /cardpayments returns card balance",
      r.status === 200 && typeof r.data.cardBalance === "number",
      JSON.stringify(r.data)
    );

    // Client (role 3) cannot read card payments.
    r = await req("GET", "/cardpayments", null, clientToken);
    check(
      "Client blocked from /cardpayments -> 403",
      r.status === 403 || r.status === 401
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
    r = await req("GET", "/worker/clients", null, clientToken);
    check(
      "Client blocked from /worker/clients -> 403",
      r.status === 403 || r.status === 401
    );

    // Missing token
    r = await req("GET", "/admin/users");
    check("GET /admin/users without token -> 401", r.status === 401);

    // WebSocket auth
    const wsMsg = await wsAuth(workerToken);
    check(
      "WebSocket auth",
      wsMsg.type === "auth_ok" && wsMsg.username === "worker",
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

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
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, setCookie };
}

// The login response includes the token in its JSON body (for the Electron
// client's Bearer auth) AND in the HttpOnly cookie. Tests read it from the
// Set-Cookie header, which works regardless of COOKIE_SECURE.
function tokenFromSetCookie(setCookie) {
  if (!setCookie) return null;
  const match = /(?:^|;\s*)token=([^;]+)/i.exec(setCookie);
  return match ? match[1] : null;
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
      if (msg.type === "presence_update") return;
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
    const adminToken = tokenFromSetCookie(r.setCookie);
    check(
      "POST /logme admin",
      r.status === 200 && !!adminToken,
      JSON.stringify(r.data)
    );

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
    const workerToken = tokenFromSetCookie(r.setCookie);

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
    const clientToken = tokenFromSetCookie(r.setCookie);

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
        PolicyNumber: "BG/TEST/1",
        BlancNumber: `B${Date.now()}`,
        CarNumber: "CB 1234 AB",
        Duration: "3 месеца",
        Branch: "ГКПП Лесово",
        Otomobil: "Otomobil",
        Price: "120",
        CurrencyType: "EUR",
        Cash: "true",
      },
      workerToken
    );
    check("POST /worker/insurances", r.status === 201, JSON.stringify(r.data));

    // Current cash (roles 1 and 2 only). Uses own test values, not DB data.
    r = await req("GET", "/currentcash", null, workerToken);
    check(
      "GET /currentcash (worker)",
      r.status === 200 && typeof r.data.balances.EUR === "number",
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
      r.status === 200 && r.data.kept && typeof r.data.kept.EUR === "number",
      JSON.stringify(r.data)
    );

    // After reset the balance is 0 and the reset is recorded.
    r = await req("GET", "/currentcash", null, workerToken);
    check(
      "GET /currentcash after reset -> 0 with reset record",
      r.status === 200 &&
        r.data.balances.EUR === 0 &&
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
      r.status === 200 && typeof r.data.balances.EUR === "number",
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

    // Worker can increase a broker balance. The movement is mirrored into
    // current cash (reason/currency are required).
    r = await req(
      "POST",
      `/brokers/${brokerId}/increase`,
      { amount: 100, reason: "test broker increase", currency: "EUR" },
      workerToken
    );
    check(
      "POST /brokers/:id/increase (worker)",
      r.status === 200 && r.data.amount === 100,
      JSON.stringify(r.data)
    );

    // Worker can reduce a broker balance. Unlike the increase endpoint, this
    // never touches current cash: current cash only ever goes up when a
    // broker balance is increased, never down when it is reduced.
    const cashBeforeBrokerReduce = (
      await req("GET", "/currentcash", null, workerToken)
    ).data.balances.EUR;

    r = await req(
      "POST",
      `/brokers/${brokerId}/reduce`,
      { amount: 50, reason: "test broker reduce", currency: "EUR" },
      workerToken
    );
    check(
      "POST /brokers/:id/reduce (worker)",
      r.status === 200 && r.data.amount === 50,
      JSON.stringify(r.data)
    );

    const cashAfterBrokerReduce = (
      await req("GET", "/currentcash", null, workerToken)
    ).data.balances.EUR;
    check(
      "Broker reduce does not change current cash",
      cashAfterBrokerReduce === cashBeforeBrokerReduce,
      `${cashBeforeBrokerReduce} -> ${cashAfterBrokerReduce}`
    );

    // Reducing a broker balance by more than the available current cash must
    // still succeed and may push the broker balance infinitely negative.
    r = await req(
      "POST",
      `/brokers/${brokerId}/reduce`,
      { amount: 999999999, reason: "massive reduce", currency: "EUR" },
      workerToken
    );
    check(
      "POST /brokers/:id/reduce beyond current cash -> 200 (broker may go negative)",
      r.status === 200 && r.data.amount === 999999999,
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

    // --- Deletion undoes a policy completely ---------------------------
    const getCash = async () =>
      (await req("GET", "/currentcash", null, adminToken)).data.balances.EUR;
    const getCard = async () =>
      (await req("GET", "/cardpayments", null, adminToken)).data.cardBalance;

    // Self-contained fixtures: a dedicated broker + email so these checks do
    // not depend on whatever brokers/policies the database already holds.
    const delStamp = Date.now();
    const delEmail = `deltest${delStamp}@broker.example`;
    const rangeBase = (delStamp % 100000000) * 10 + 1000;
    r = await req(
      "POST",
      "/brokers",
      {
        Name: `DeleteTestBroker${delStamp}`,
        CashBalance: 1000,
        PolicyRangeStart: rangeBase,
        PolicyRangeEnd: rangeBase + 9,
        InactivePolicies: 10,
        emails: [delEmail],
      },
      adminToken
    );
    check("Create delete-test broker -> 201", r.status === 201, JSON.stringify(r.data));
    const delBrokerId = r.data.broker?.id;
    const getDelBroker = async () =>
      (await req("GET", `/brokers/${delBrokerId}`, null, adminToken)).data.broker;
    const createBrokerPolicy = (blanc, price) =>
      req(
        "POST",
        "/worker/insurances",
        {
          BlancNumber: blanc,
          PolicyNumber: `P${blanc}`,
          CarNumber: "CB 7777 GG",
          Price: String(price),
          EmailFrom: delEmail,
          PaymentType: "Broker",
        },
        workerToken
      );

    // Broker policy: delete refunds the full price and restores the blanc.
    const delBrokerBlanc = String(rangeBase + 1);
    r = await createBrokerPolicy(delBrokerBlanc, 500);
    check("POST broker insurance for delete -> 201", r.status === 201, JSON.stringify(r.data));
    let bBefore = await getDelBroker();
    r = await req("DELETE", `/insurances/${delBrokerBlanc}`, null, adminToken);
    check(
      "DELETE broker insurance -> 200",
      r.status === 200 && r.data.brokerRefund === 500,
      JSON.stringify(r.data)
    );
    let bAfter = await getDelBroker();
    check(
      "Delete refunds full price to broker balance",
      Math.abs(Number(bAfter.CashBalance) - Number(bBefore.CashBalance) - 500) <
        0.01,
      `${bBefore.CashBalance} -> ${bAfter.CashBalance}`
    );
    check(
      "Delete restores broker blanc (InactivePolicies + 1)",
      Number(bAfter.InactivePolicies) - Number(bBefore.InactivePolicies) === 1,
      `${bBefore.InactivePolicies} -> ${bAfter.InactivePolicies}`
    );

    r = await req("DELETE", `/insurances/${delBrokerBlanc}`, null, adminToken);
    check("Deleting twice -> 400", r.status === 400, JSON.stringify(r.data));

    // Worker cannot delete.
    r = await req("DELETE", `/insurances/${delBrokerBlanc}`, null, workerToken);
    check("Worker blocked from DELETE /insurances -> 403", r.status === 403);

    // Cash walk-in: delete removes the price from current cash.
    const cashBlanc = `DELCASH${Date.now()}`;
    await req(
      "POST",
      "/worker/insurances",
      { BlancNumber: cashBlanc, PolicyNumber: `P${cashBlanc}`, CarNumber: "CB 4444 DD", Price: "80", Cash: "true" },
      workerToken
    );
    let cashBefore = await getCash();
    r = await req("DELETE", `/insurances/${cashBlanc}`, null, adminToken);
    let cashAfter = await getCash();
    check(
      "Delete cash walk-in removes price from current cash",
      r.status === 200 && Math.abs(cashBefore - cashAfter - 80) < 0.01,
      `${cashBefore} -> ${cashAfter} ${JSON.stringify(r.data)}`
    );

    // Card walk-in: delete removes the price from the card balance.
    const cardBlanc = `DELCARD${Date.now()}`;
    await req(
      "POST",
      "/worker/insurances",
      { BlancNumber: cardBlanc, PolicyNumber: `P${cardBlanc}`, CarNumber: "CB 5555 EE", Price: "60", Cash: "false" },
      workerToken
    );
    let cardBeforeDel = await getCard();
    let cashBeforeCardDel = await getCash();
    r = await req("DELETE", `/insurances/${cardBlanc}`, null, adminToken);
    check(
      "Delete card walk-in removes price from card balance only",
      r.status === 200 &&
        Math.abs(cardBeforeDel - (await getCard()) - 60) < 0.01 &&
        Math.abs((await getCash()) - cashBeforeCardDel) < 0.01,
      JSON.stringify(r.data)
    );

    // Annulment refunds the broker but does NOT restore the blanc; a later
    // deletion restores the blanc without refunding the broker again.
    const annulBlanc = String(rangeBase + 2);
    r = await createBrokerPolicy(annulBlanc, 200);
    check("POST broker insurance for annul -> 201", r.status === 201, JSON.stringify(r.data));
    bBefore = await getDelBroker();
    r = await req("POST", `/insurances/${annulBlanc}/annul`, { reason: "broker" }, workerToken);
    bAfter = await getDelBroker();
    check(
      "Annul with broker fault refunds price - fee to broker",
      r.status === 200 &&
        Math.abs(
          Number(bAfter.CashBalance) -
            Number(bBefore.CashBalance) -
            (200 - Number(r.data.fee || 0))
        ) < 0.01 &&
        Number(bAfter.InactivePolicies) === Number(bBefore.InactivePolicies),
      `${JSON.stringify(r.data)} inactive ${bBefore.InactivePolicies} -> ${bAfter.InactivePolicies}`
    );

    // Worker cannot change fault of an already-annulled insurance.
    r = await req("PATCH", `/insurances/${annulBlanc}`, { AnnulReason: "none" }, workerToken);
    check(
      "Worker blocked from changing annulled insurance fault -> 403",
      r.status === 403,
      JSON.stringify(r.data)
    );

    // Admin can change fault of an already-annulled insurance to "none",
    // refunding the kept fee to the broker.
    const keptFee = Number((await req("GET", `/insurances?blancNumber=${annulBlanc}`, null, adminToken)).data.insurances[0].AnnulFee || 0);
    bBefore = await getDelBroker();
    r = await req("PATCH", `/insurances/${annulBlanc}`, { AnnulReason: "none" }, adminToken);
    bAfter = await getDelBroker();
    check(
      "Admin changing annulled insurance fault to none refunds kept fee to broker",
      r.status === 200 &&
        r.data.insurance.AnnulReason === "none" &&
        Number(r.data.insurance.AnnulFee) === 0 &&
        Math.abs(Number(bAfter.CashBalance) - Number(bBefore.CashBalance) - keptFee) < 0.01,
      `${JSON.stringify(r.data)} balance ${bBefore.CashBalance} -> ${bAfter.CashBalance}`
    );
    bBefore = bAfter;
    r = await req("DELETE", `/insurances/${annulBlanc}`, null, adminToken);
    bAfter = await getDelBroker();
    check(
      "Delete after annul restores blanc without double refund",
      r.status === 200 &&
        Math.abs(Number(bAfter.CashBalance) - Number(bBefore.CashBalance)) < 0.01 &&
        Number(bAfter.InactivePolicies) - Number(bBefore.InactivePolicies) === 1,
      `${JSON.stringify(r.data)} balance ${bBefore.CashBalance} -> ${bAfter.CashBalance}`
    );

    // GET /cardpayments returns the current card balance (admin only).
    r = await req("GET", "/cardpayments", null, adminToken);
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

    // -----------------------------------------------------------------
    // Sub-broker display pricing vs. main broker sale pricing
    // -----------------------------------------------------------------
    const sbStamp = Date.now();
    const mainEmail = `main_${sbStamp}@broker.example`;
    const subEmail = `sub_${sbStamp}@broker.example`;

    // 1. Create main broker and set its sale tariffs (Auto 30 = 26)
    r = await req(
      "POST",
      "/brokers",
      { Name: `MAIN_${sbStamp}`, CashBalance: 1000, emails: [mainEmail] },
      adminToken
    );
    const mainBrokerId = r.data?.broker?.id;
    check("Create main broker for sub-broker test", r.status === 201 && !!mainBrokerId);

    r = await req(
      "PUT",
      `/brokers/${mainBrokerId}/pricing`,
      { pricing: { Auto: { 15: 21, 30: 26, 90: 32 } } },
      adminToken
    );
    check("Set main broker sale pricing", r.status === 200);

    // 2. Create sub-broker mapped to main broker and top up 100 via /increase
    r = await req(
      "POST",
      "/brokers",
      {
        Name: `SUB_${sbStamp}`,
        CashBalance: 0,
        ParentBrokerId: mainBrokerId,
        emails: [subEmail],
      },
      adminToken
    );
    const subBrokerId = r.data?.broker?.id;
    check(
      "Create sub-broker with ParentBrokerId",
      r.status === 201 && !!subBrokerId && r.data?.broker?.hidePricing === true
    );

    r = await req(
      "POST",
      `/brokers/${subBrokerId}/increase`,
      { amount: 100, reason: "initial top-up", currency: "EUR" },
      adminToken
    );
    check("Top up sub-broker balance by 100", r.status === 200);

    // 3. Set sub-broker display tariffs (Auto 30 = 35, different from main broker's 26)
    r = await req(
      "PUT",
      `/brokers/${subBrokerId}/pricing`,
      { pricing: { Auto: { 15: 28, 30: 35, 90: 42 } } },
      adminToken
    );
    check("Set sub-broker display pricing", r.status === 200);

    // 4. GET /tariffs/policy-pricing for sub-broker email returns MAIN broker's price (26), NOT 35
    r = await req(
      "GET",
      `/tariffs/policy-pricing?from=${encodeURIComponent(subEmail)}`,
      null,
      workerToken
    );
    check(
      "GET /tariffs/policy-pricing for sub-broker returns main broker sale price (26)",
      r.status === 200 && Number(r.data?.pricing?.Auto?.["30"]) === 26,
      JSON.stringify(r.data)
    );

    // 5. Create policy for sub-broker (even if client sends 35, DB sale price must be 26)
    const sbBlanc = `SB${sbStamp}`;
    r = await req(
      "POST",
      "/worker/insurances",
      {
        PolicyNumber: `P-${sbBlanc}`,
        BlancNumber: sbBlanc,
        CarNumber: "34SUB123",
        Duration: "1 месец",
        Branch: "ГКПП Лесово",
        Otomobil: "Automobile",
        Price: "35",
        CurrencyType: "EUR",
        EmailFrom: subEmail,
        PaymentType: "Broker",
        DisableReturnEmail: true,
      },
      workerToken
    );
    check("Create policy for sub-broker -> 201", r.status === 201, JSON.stringify(r.data));

    // 6. Verify DB sale price (insurance.Price) is 26 and DB CashBalance owed to us is 100 - 26 = 74
    r = await req("GET", `/insurances?blancNumber=${sbBlanc}`, null, adminToken);
    check(
      "DB insurance.Price for sub-broker is main broker sale price (26)",
      r.status === 200 && Number(r.data?.insurances?.[0]?.Price) === 26,
      JSON.stringify(r.data?.insurances?.[0])
    );

    r = await req("GET", `/brokers/${subBrokerId}`, null, adminToken);
    check(
      "DB CashBalance for sub-broker (owed to us) uses main broker price (100 - 26 = 74)",
      r.status === 200 && Math.abs(Number(r.data?.broker?.CashBalance) - 74) < 0.01,
      JSON.stringify(r.data?.broker)
    );

    // 7. Verify underlings endpoint (shown to main broker) uses sub-broker display price (35)
    r = await req("GET", `/brokers/${mainBrokerId}/underlings`, null, adminToken);
    const uEntry = (r.data?.underlings || []).find((u) => u.id === subBrokerId);
    check(
      "GET /brokers/:id/underlings shows sub-broker display totalPrice (35), totalBalance (35), and display CashBalance (65)",
      r.status === 200 &&
        uEntry &&
        Number(uEntry.totalPrice) === 35 &&
        Number(uEntry.totalBalance) === 35 &&
        Math.abs(Number(uEntry.CashBalance) - 65) < 0.01 &&
        Number(r.data?.totalBalance) === 35,
      JSON.stringify(r.data)
    );

    // 8. Verify GET /brokers/:subBrokerId/policies returns display price (35), never sale price (26)
    r = await req("GET", `/brokers/${subBrokerId}/policies`, null, adminToken);
    check(
      "GET /brokers/:subBrokerId/policies returns display price (35), never sale price (26)",
      r.status === 200 && Number(r.data?.policies?.[0]?.Price) === 35,
      JSON.stringify(r.data?.policies?.[0])
    );

    // 9. Register, approve, and log in as the sub-broker (role 3) to verify
    //    sub-brokers NEVER see the main broker's sale prices (26 / 74)
    const subUsername = `SUB_${sbStamp}`;
    await req("POST", "/userreg", { username: subUsername, password: "subpass123" });
    await req(
      "POST",
      `/admin/users/${encodeURIComponent(subUsername)}/approve`,
      { brokerId: subBrokerId },
      adminToken
    );
    r = await req("POST", "/logme", { username: subUsername, password: "subpass123" });
    const subToken = tokenFromSetCookie(r.setCookie) || r.data?.token;
    check("Sub-broker login -> 200", r.status === 200 && !!subToken);

    r = await req("GET", "/tariffs/my-pricing", null, subToken);
    check(
      "Sub-broker GET /tariffs/my-pricing returns only display prices (35), never sale price (26)",
      r.status === 200 && Number(r.data?.pricing?.Auto?.["30"]) === 35,
      JSON.stringify(r.data)
    );

    r = await req("GET", `/brokers/${subBrokerId}`, null, subToken);
    check(
      "Sub-broker GET /brokers/:id shows display CashBalance (65), never DB sale CashBalance (74)",
      r.status === 200 && Math.abs(Number(r.data?.broker?.CashBalance) - 65) < 0.01,
      JSON.stringify(r.data?.broker)
    );

    r = await req("GET", "/brokers/biweekly", null, subToken);
    check(
      "Sub-broker GET /brokers/biweekly shows display CashBalance (65) and movement (65), never 74",
      r.status === 200 &&
        Math.abs(Number(r.data?.brokers?.[0]?.CashBalance) - 65) < 0.01 &&
        Math.abs(Number(r.data?.brokers?.[0]?.periods?.[0]?.balanceMovement) - 65) < 0.01,
      JSON.stringify(r.data?.brokers?.[0])
    );

    r = await req("GET", `/brokers/${subBrokerId}/history`, null, subToken);
    const subPolicyMov = (r.data?.movements || []).find((m) => m.Type === "policy");
    check(
      "Sub-broker GET /brokers/:id/history shows display movement (-35) and balance (65), never -26/74",
      r.status === 200 &&
        subPolicyMov &&
        Number(subPolicyMov.Amount) === -35 &&
        Math.abs(Number(r.data?.broker?.CashBalance) - 65) < 0.01,
      JSON.stringify(r.data)
    );

    r = await req("GET", "/client/insurances", null, subToken);
    check(
      "Sub-broker GET /client/insurances shows display price (35), never sale price (26)",
      r.status === 200 && Number(r.data?.insurances?.[0]?.Price) === 35,
      JSON.stringify(r.data?.insurances?.[0])
    );

    r = await req("GET", `/brokers/${mainBrokerId}/pricing`, null, subToken);
    check(
      "Sub-broker blocked from GET /brokers/:mainBrokerId/pricing -> 403",
      r.status === 403
    );

    // Clean up test fixtures
    await req("POST", `/admin/users/${encodeURIComponent(subUsername)}/delete`, null, adminToken);
    await req("DELETE", `/insurances/${sbBlanc}`, null, adminToken);
    await req("DELETE", `/brokers/${subBrokerId}`, null, adminToken);
    await req("DELETE", `/brokers/${mainBrokerId}`, null, adminToken);
    if (delBrokerId) await req("DELETE", `/brokers/${delBrokerId}`, null, adminToken);
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

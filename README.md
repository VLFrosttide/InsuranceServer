# InsuranceServer

Insurance management server (Express + MySQL + WebSocket + Gmail polling) with an
Electron client (`InsuranceClient`).

## Prerequisites

- Node.js 20.12+ (tested with 24.x)
- MySQL 8 running on port `5500` (database `insurancedb`)
- A `.env` file in the repo root with at least:

  ```env
  DBPassword=your_mysql_root_password
  ```

  Gmail polling is optional. If you want it, also set `ClientID`, `ClientSecret`,
  `RedirectUri`, and the `GMAIL_*` token variables.

## One-time database setup

```bash
npm run db:setup
```

This creates the `insurancedb` database, adds any missing columns, creates the
`tokens`/`tasks` tables, and seeds demo accounts:

| Username | Password      | Role   |
| -------- | ------------- | ------ |
| admin    | AdminPass123  | admin  |
| worker   | WorkerPass123 | worker |
| client   | ClientPass123 | client |
| list4e   | Pedese50      | worker |

## Run the server

```bash
npm start
```

The server listens on `http://127.0.0.1:5501`.

To run without Gmail integration (useful for quick testing):

```powershell
$env:DISABLE_GMAIL="1"; npm start
```

## Run the tests

```bash
npm run test:e2e
```

This starts the server (with Gmail disabled for determinism) and exercises the
login, registration, tiered admin/worker/client endpoints, and the WebSocket.

## Run the client

In a separate terminal:

```bash
cd ..\InsuranceClient
npm start
```

Log in with any of the demo accounts above. The client routes by role:

- worker / list4e → Add Insurance form + dashboard
- admin → dashboard (users, stats, insurances)
- client → dashboard (profile, my insurances)

## HTTP API

- `POST /logme` — login (returns a session `token`)
- `POST /userreg` — register a new client account
- `GET /health` — liveness check

Protected endpoints require `Authorization: Bearer <token>`:

- Admin (`role 1`): `/admin`, `/admin/users`, `/admin/stats`, `/admin/insurances`,
  `PATCH /admin/users/:username`
- Worker (`role 2`): `/worker`, `/worker/tasks`, `/worker/clients`,
  `POST /worker/clients/balance`, `POST /worker/insurances`
- Client (`role 3`): `/client`, `/client/profile`, `/client/insurances`

## WebSocket

`ws://127.0.0.1:5501/ws`

1. Send `{ "type": "auth", "token": "<login token>" }` to authenticate.
2. Connected users with role `2` (worker) receive
   `{ "type": "new_email", "data": {...} }` when the Gmail poller finds a new
   unread message.

## Gmail polling

Enabled by default when `.env` has valid OAuth credentials. It runs in the
background and does not block the REST/WebSocket server. Attachments are saved
under `attachments/` unless `SAVE_ATTACHMENTS_TO_DISK=0`.

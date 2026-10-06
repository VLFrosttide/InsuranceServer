# InsuranceServer

Insurance management server (Express + MySQL + WebSocket + Gmail polling) with an
Electron client (`InsuranceClient`).

## Prerequisites

- Node.js 20.12+ (tested with 24.x)
- MySQL 8 running on port `3306` (database `insurancedb`)
- A `.env` file in the repo root with at least:

  ```env
  DB_PASSWORD=your_mysql_root_password
  ```

  Gmail polling is optional. If you want it, also set `CLIENT_ID`, `CLIENT_SECRET`,
  `REDIRECT_URI`, and the `GMAIL_*` token variables.

## One-time database setup

```bash
npm run db:setup
```

This creates the `insurancedb` database, adds any missing columns, creates the
required tables, and seeds demo accounts:

| Username | Password      | Role   |
| -------- | ------------- | ------ |
| admin    | AdminPass123  | admin  |
| worker   | WorkerPass123 | worker |
| client   | ClientPass123 | client |

## Database schema

The database (`insurancedb`) contains the following tables. `db/setup.js`
creates every table that is missing (including `users` and `insurance`) and
migrates existing tables, so it works against a completely empty database as
well as an existing deployment.

### `users`

Stores every account on the system (admins, workers, clients).

| Column     | Type          | Notes                             |
| ---------- | ------------- | --------------------------------- |
| `Username` | `VARCHAR(45)` | Unique login name (PK-equivalent) |
| `Password` | `VARCHAR`     | bcrypt hash                       |
| `Role`     | `INT`         | `1` admin, `2` worker, `3` client |
| `Status`   | `VARCHAR(20)` | `active` or `suspended`           |

Use case: authentication, authorization, admin/worker dashboards, and client
profiles. Balances live on `brokers` (a client can also be a
broker). `Role` defaults to `3` (client) when added by the migration.

### `insurance`

One row per insurance policy.

| Column         | Notes                                              |
| -------------- | -------------------------------------------------- |
| `Author`       | User who created the policy                        |
| `CreationDate` | When the policy was created                        |
| `PolicyNumber` | Policy number                                      |
| `BlancNumber`  | Blanc number (unique; used for lookups)            |
| `Price`        | Policy price                                       |
| `CurrencyType` | e.g. `EUR`                                         |
| `Duration`     | Duration in integer days                           |
| `Broker`       | Broker name (inferred from email sender)           |
| `BrokerId`     | Link to `brokers.id`                               |
| `Branch`       | Branch (selected at login)                         |
| `Otomobil`     | Vehicle/car flag value                             |
| `StartDate`    | Policy start date                                  |
| `PaymentType`  | `"Cash"` or `"Card"`                               |
| `NonTurk`      | `1` if the +5 non-Turk surcharge applied           |
| `CardFee`      | `1` if the +2 card fee applied (never with `Cash`) |

`NonTurk` and `CardFee` are flags only: their amounts (+5 / +2) are already
included in `Price` by the client. The server ignores `CardFee` for `Cash`
policies. Both columns are added automatically by `db/setup.js`.

The table also carries annulment columns (`Annulled`, `AnnulReason`,
`AnnulFee`, `AnnulDate`, `AnnulBy`) and soft-delete columns (`Deleted`,
`DeletedAt`, `DeletedBy`). Deleting a policy from the admin panel
(`DELETE /insurances/:blancNumber`, admin-only) never removes the row: it only
sets `Deleted = 1` plus `DeletedAt`/`DeletedBy`, so the policy is kept in the
database for record-keeping but is excluded from `/admin/insurances` (unless
`?includeDeleted=1` is passed), `/insurances`, and `/client/insurances` — and
therefore is no longer picked up by reconciliation/report parsing.

Use case: the core business entity — created by workers, listed for clients,
edited by admins/workers, and linked to a broker and to the current-cash
ledger. `BlancNumber` is the natural unique key used for create/update/duplicate
checks.

### `tokens`

Sessions issued at login.

| Column     | Type          | Notes                        |
| ---------- | ------------- | ---------------------------- |
| `Token`    | `VARCHAR(64)` | Session token (primary key)  |
| `Username` | `VARCHAR(45)` | Owner of the token           |
| `Expires`  | `DATETIME`    | Expiry (12 hours from login) |

Use case: `Authorization: Bearer <token>` session auth (`/logme` inserts, the
auth middleware validates token + expiry, and a login deletes any previous
token for the same user).

### `current_cash`

Single running cash balance (one row, `id = 1`).

| Column        | Type            | Notes                  |
| ------------- | --------------- | ---------------------- |
| `id`          | `INT`           | Fixed row id (`1`)     |
| `CurrentCash` | `DECIMAL(15,2)` | The current balance    |
| `UpdatedAt`   | `DATETIME`      | Auto-updated timestamp |

Use case: the single company cash balance. Increased by policy creation and
`POST /currentcash/increase`, reduced by `POST /currentcash/reduce`, reset to
`0` by `POST /currentcash/reset`. It is not reset automatically.

### `cash_transactions`

Ledger of every cash increase/reduction.

| Column      | Type            | Notes                  |
| ----------- | --------------- | ---------------------- |
| `id`        | `INT`           | Auto-increment PK      |
| `Type`      | `VARCHAR(20)`   | `increase` or `reduce` |
| `Amount`    | `DECIMAL(15,2)` | Movement amount        |
| `Username`  | `VARCHAR(45)`   | Who performed it       |
| `Reason`    | `VARCHAR(255)`  | Human-readable reason  |
| `CreatedAt` | `DATETIME`      | Creation time          |

Use case: audit trail for `current_cash` movements (returned by
`GET /currentcash`).

### `cash_resets`

Records every reset of the current cash balance.

| Column       | Type            | Notes                     |
| ------------ | --------------- | ------------------------- |
| `id`         | `INT`           | Auto-increment PK         |
| `Username`   | `VARCHAR(45)`   | Who performed the reset   |
| `KeptAmount` | `DECIMAL(15,2)` | Amount kept at reset time |
| `CreatedAt`  | `DATETIME`      | Reset time                |

Use case: audit trail for `POST /currentcash/reset` (returned by
`GET /currentcash`).

### `CardBalance`

Single running card balance (one row, `id = 1`).

| Column        | Type            | Notes                  |
| ------------- | --------------- | ---------------------- |
| `id`          | `INT`           | Fixed row id (`1`)     |
| `CardBalance` | `DECIMAL(15,2)` | The current balance    |
| `UpdatedAt`   | `DATETIME`      | Auto-updated timestamp |

Use case: the single card-payment balance. Increased when an insurance policy is
created with `PaymentType = "Card"`.

### `brokers`

Broker accounts.

| Column             | Type            | Notes                             |
| ------------------ | --------------- | --------------------------------- |
| `id`               | `INT`           | Auto-increment PK                 |
| `Name`             | `VARCHAR(100)`  | Unique broker name                |
| `CashBalance`      | `DECIMAL(15,2)` | Broker cash balance (may go neg.) |
| `PolicyRangeStart` | `INT`           | Start of blanc-number range       |
| `PolicyRangeEnd`   | `INT`           | End of blanc-number range         |
| `InactivePolicies` | `INT`           | Remaining inactive policies       |
| `CreatedAt`        | `DATETIME`      | Creation time                     |

Use case: broker management. Admins/workers can increase/reduce a broker
balance. Creating an insurance resolves its broker from the sender email (broker_emails) and deducts a flat fee (the full Price) from its balance while decrementing InactivePolicies. No percentages are used anywhere.

### `broker_emails`

Email addresses attached to a broker (one broker → many emails).

| Column     | Type           | Notes              |
| ---------- | -------------- | ------------------ |
| `id`       | `INT`          | Auto-increment PK  |
| `BrokerId` | `INT`          | FK to `brokers.id` |
| `Email`    | `VARCHAR(255)` | Email address      |

Use case: stores the multiple contact emails of each broker.

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

- `POST /logme` — login (sets an HttpOnly session cookie and also returns the
  token in the JSON body so the Electron client can use Bearer auth)
- `POST /userreg` — register a new client account
- `GET /health` — liveness check

Protected endpoints authenticate with either the `token` cookie set at login or
an `Authorization: Bearer <token>` header.

The session cookie is `HttpOnly` and `Secure` (and `SameSite=Lax`), so the
browser only sends it over HTTPS and frontend JavaScript cannot read it. For
local development over plain HTTP, set `COOKIE_SECURE=false` so the cookie is
still sent over `http://`. The Electron client does not rely on the cookie:
`/logme` also returns the token in the JSON body, and the client stores it in
`localStorage` and sends it back as `Authorization: Bearer <token>`.

- Admin (`role 1`): `/admin`, `/admin/users`, `/admin/stats`, `/admin/insurances`,
  `PATCH /admin/users/:username`,
  `POST /admin/users/:username/suspend`,
  `POST /admin/users/:username/delete`,
  `POST /admin/users/:username/promote`
- Worker (`role 2`): `/worker`, `/worker/clients`,
  `POST /worker/clients/balance`, `POST /worker/insurances`
- Client (`role 3`): `/client`, `/client/profile`, `/client/insurances`
- Broker + current cash (`role 1`/`role 2`): see the sections below.

## Current cash

Current cash is a single running balance. It is NOT reset automatically; it
resets to `0` only when an admin (role 1) or worker (role 2) explicitly calls
the reset endpoint. Each increase and reduction records the user who performed
it and a reason. Each reset is also recorded with the user who performed it and
the amount that was kept at the time of the reset.

- `GET /currentcash` — current total plus transaction and reset history
- `POST /currentcash/increase` — body `{ "amount": 50, "reason": "..." }`
- `POST /currentcash/reduce` — body `{ "amount": 20, "reason": "..." }`
- `POST /currentcash/reset` — reset the balance to `0` (records user + kept amount)

Reductions are rejected when the amount exceeds the available cash. Creating an
insurance automatically increases the current cash by the policy `Price`, with
the logged-in user as the author and the blanc number as the reason.

## Card balance

Card balance is a single running balance, separate from current cash. Creating
an insurance with `PaymentType = "Card"` (the `Cash` request field set to
`false`) adds the policy `Price` to the card balance instead of current cash.

- `GET /cardpayments` — current card balance

## Broker balance

Each broker has a cash balance. Only admins
(role 1) and workers (role 2) can view or change a broker balance (unlike
current cash, a broker balance may go infinitely negative).

Current cash and broker balance are intentionally asymmetric:

- `POST /brokers/:id/increase` mirrors the same amount into current cash
  (money is actually coming in), so current cash goes up too.
- `POST /brokers/:id/reduce`, and the automatic per-policy deduction made when
  an insurance is created from an email card, never touch current cash.
  Current cash never decreases as a side effect of a broker balance
  reduction, and a reduction is never blocked by how much current cash
  happens to be available.

- `GET /brokers` — list all brokers with balance and inactive policies
- `GET /brokers/:id` — single broker
- `POST /brokers/:id/increase` — body `{ "amount": 100 }` (mirrors into current cash)
- `POST /brokers/:id/reduce` — body `{ "amount": 50 }` (may go infinitely negative; does not touch current cash)

Admin-only (`role 1`) broker management:

- `GET /brokers/export?format=json|csv` — extract all brokers (with emails and
  linked insurance counts) as JSON or a downloadable CSV
- `POST /brokers` — create a broker
- `PATCH /brokers/:id` — update a broker's fields and/or its emails
- `DELETE /brokers/:id` — delete a broker (detaches any linked insurances)

Each created insurance whose email sender is associated with a broker charges that broker a flat fee: the broker balance is reduced by the full Price (it may go infinitely negative, and this never touches current cash) and the broker InactivePolicies is decremented by 1.

## WebSocket

`ws://127.0.0.1:5501/ws`

1. Send `{ "type": "auth", "token": "<login token>", "branch": "..." }` to
   authenticate.
2. Connected users with role `2` (worker) receive
   `{ "type": "new_email", "data": {...} }` when the Gmail poller finds a new
   unread message. Send `{ "type": "list_emails" }` to (re-)fetch the current
   cards.
3. Email cards carry only attachment **metadata** (`id`, `filename`,
   `mimeType`, `size`) — the bytes are not downloaded or sent until requested.
   When a worker opens a card, send
   `{ "type": "get_attachment", "messageId": "<email message id>", "id": "<attachment id>" }`
   to fetch one attachment's bytes; the server replies with
   `{ "type": "get_attachment", ok, id, filename, mimeType, size, base64 }`.
   `base64` is `null` for files larger than 5 MB, which are instead written to
   disk under `attachments/` (see below).

## Gmail polling

Enabled by default when `.env` has valid OAuth credentials. It runs in the
background and does not block the REST/WebSocket server. Attachments are loaded
lazily — saved under `attachments/` (unless `SAVE_ATTACHMENTS_TO_DISK=0`) only
when a worker actually opens the card and the file is too large to inline.

The server polls up to three Gmail inboxes (`Account1`, `Account2`,
`Account3`). Only the inboxes whose OAuth credentials are configured are
started, so you can run with 1, 2, or 3 boxes without erroring. If no Gmail
credentials are set at all, polling is skipped.

`Account1` uses the base `GMAIL_*` token variables; `Account2` and `Account3`
use the same names with a `_2` / `_3` suffix:

```env
# Account1
GMAIL_ACCESS_TOKEN=...
GMAIL_REFRESH_TOKEN=...
GMAIL_SCOPE=...
GMAIL_TOKEN_TYPE=Bearer
GMAIL_EXPIRY_DATE=...

# Account2
GMAIL_ACCESS_TOKEN_2=...
GMAIL_REFRESH_TOKEN_2=...
GMAIL_SCOPE_2=...
GMAIL_TOKEN_TYPE_2=Bearer
GMAIL_EXPIRY_DATE_2=...

# Account3
GMAIL_ACCESS_TOKEN_3=...
GMAIL_REFRESH_TOKEN_3=...
GMAIL_SCOPE_3=...
GMAIL_TOKEN_TYPE_3=Bearer
GMAIL_EXPIRY_DATE_3=...
```

Each account uses its own OAuth client, so `CLIENT_ID`/`CLIENT_SECRET` are
account-specific too. `Account1` reads the base names; `Account2`/`Account3`
read the `_2`/`_3` variants. `REDIRECT_URI` defaults to the shared value but can
also be overridden per account via `REDIRECT_URI_2` / `REDIRECT_URI_3`.

```env
# Account1
CLIENT_ID=...
CLIENT_SECRET=...

# Account2
CLIENT_ID_2=...
CLIENT_SECRET_2=...

# Account3
CLIENT_ID_3=...
CLIENT_SECRET_3=...
```

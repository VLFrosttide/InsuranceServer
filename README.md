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
required tables, and applies the data steps (branch registry, default tariffs,
card balances, broker codes, balance backfills). Run it when you want those
data steps to happen — it is a deliberate, one-off command.

**Starting the server only applies schema changes — it never seeds.** Restarting
`npm start` does not re-insert branch/broker seed rows, re-run backfills or
recalculate broker balances, so local edits always survive a restart. If a
throw-away database really should be seeded while the server boots, opt in with
`DB_SEED_ON_START=1`:

```powershell
$env:DB_SEED_ON_START = "1"; npm start
```

The accounts used by `npm run test:e2e` (`admin` / `AdminPass123`,
`worker` / `WorkerPass123`, `client` / `ClientPass123`) are not created by
`db/setup.js`; create them once through the admin dashboard (registration +
approval) or insert them directly.

## Seeding local from the live database

`npm run db:setup` prepares an empty/seed-only database. To develop against
real data, copy the live database into the local `insurancedb`:

```powershell
npm run db:seed:live
```

`db/seed-from-live.ps1` reads the connection details from `.env`:

| Settings | Meaning |
| -------- | ------- |
| `LIVE_DB_HOST` `LIVE_DB_PORT` `LIVE_DB_USER` `LIVE_DB_PASSWORD` `LIVE_DB_NAME` | source to dump |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | local target to load |

What it does:

1. `mysqldump --single-transaction` of the live database into
   `backups/<live-db>-<timestamp>.sql` (git-ignored: real customer data).
2. `node --env-file=.env db/setup.js`, so the local database and every table
   exist and match the server code.
3. Loads the dump into the local database.
4. Clears `tokens` (live login sessions), `email_outbox` (a pending reply would
   otherwise be re-sent to a real customer by the local server) and the
   `app_settings.billing*` rows, then prints row counts.

Hostinger rejects remote MySQL connections until the client IP is whitelisted
(hPanel → Databases → Remote MySQL); without that `mysqldump` stops with
`ERROR 1045 (28000): Access denied for user ... (using password: YES)`.
Either whitelist the IP, or export the database from hPanel's phpMyAdmin and
import the downloaded file:

```powershell
npm run db:seed:file -- C:\Downloads\u174622325_InsuranceDB.sql
```

The live server runs MariaDB, so the script disables the MySQL 8 client's
`--column-statistics` query (MariaDB has no `information_schema.COLUMN_STATISTICS`
and the dump would otherwise stop with `ERROR 1109`).

Useful switches:

- `-SchemaOnly` — structure only, no rows.
- `-DataOnly` — rows only, on top of the local schema.
- `-Tables insurance,brokers` — only those tables.
- `-NoImport` — keep the dump and stop.
- `-KeepSessions` — keep the live `tokens` rows.

## Patching the broker balance history (one-off)

The broker balance is rebuilt from the insurance table and `broker_payments`
(minus the voids), while `broker_balance_movements` is the history the balance
history page walks. The server writes and patches that history itself on every
change, so it normally needs no help. Rows written before a blanc correction was
carried into the history, however, keep the policy's old number, and the page
then shows the sale as its own entry without the policy's details:

```powershell
npm run db:repair:ledger                     # report only
npm run db:repair:ledger -- --apply          # write the relabels
npm run db:repair:ledger -- --broker=35      # one broker
```

`db/repair-broker-ledger.js` relabels only unambiguous rows (one live insurance
created at the same second with no rows of its own, one sale row for it) and
changes no money: it never un-hides a row, because a hidden row is a void the
balance honours, and it never moves `brokers.CashBalance`. Anything it cannot
match is printed for review. It is idempotent and only inspects brokers that
have a starting balance. Always run it without `--apply` first.

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
| `Deleted`  | `TINYINT(1)`  | `1` = soft-deleted (with `DeletedAt` / `DeletedBy`) |

Use case: authentication, authorization, admin/worker dashboards, and client
profiles. Balances live on `brokers` (a client can also be a
broker). `Role` defaults to `3` (client) when added by the migration.

Deleting an account from the Users screen never removes the row: it is flagged
with `Deleted`/`DeletedAt`/`DeletedBy` (its sessions are dropped, so it cannot
sign in, and it disappears from `GET /admin/users`), and an admin restores it
with `POST /admin/users/:username/restore`.

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

Deleting and annulling are different operations:

- **Annul** (`POST /insurances/:blancNumber/annul`) refunds the price minus a
  fault fee through the original payment channel and refunds the full price to
  the broker's balance for email policies. The blanc stays used up
  (`InactivePolicies` is not changed).
- **Delete** undoes the policy completely: walk-in (Cash/Card) money is removed
  from current cash / the card balance and Total cash; for email policies the
  full price is refunded to the broker's balance, removed from the Broker part
  of Total cash, and the blanc is given back (`InactivePolicies + 1`). Deleting
  an already-annulled policy removes only the kept annulment fee, does not
  refund the broker again, but still restores the blanc. If current cash
  cannot cover the removal, the delete is rejected with `400` and nothing
  changes.

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
`POST /currentcash/increase`, reduced by `POST /currentcash/reduce` (the
"Expense" button) and by `POST /currentcash/handover` (money given to a person),
reset to `0` by `POST /currentcash/reset`. It is not reset automatically.

### `cash_transactions`

Ledger of every cash increase/reduction/hand-over.

| Column      | Type            | Notes                      |
| ----------- | --------------- | -------------------------- |
| `id`        | `INT`           | Auto-increment PK          |
| `Type`      | `VARCHAR(20)`   | `increase`, `reduce` (an expense) or `handover` |
| `Amount`    | `DECIMAL(15,2)` | Movement amount            |
| `Username`  | `VARCHAR(45)`   | Who performed it           |
| `Reason`    | `VARCHAR(255)`  | Human-readable reason      |
| `Recipient` | `VARCHAR(100)`  | Who took hand-over money (NULL otherwise) |
| `CreatedAt` | `DATETIME`      | Creation time              |
| `Deleted`   | `TINYINT(1)`    | Soft delete flag (default `0`) |
| `DeletedAt` | `DATETIME`      | When it was deleted (NULL) |
| `DeletedBy` | `VARCHAR(45)`   | Admin who deleted it      |

Use case: audit trail for `current_cash` movements (returned by
`GET /currentcash`). A deleted row is never removed - it is flagged and skipped
by every read, and its money was reversed when it was deleted
(`DELETE /currentcash/transactions/:id`). A `handover` row is money physically
given to a person: it lowers the drawer, writes no Total cash row, and is
neither an expense nor part of Total daily cash.

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

### `broker_starting_balances` / `broker_payments`

The two inputs of a broker's balance besides its policies.

`broker_starting_balances` — one row per broker: the balance it had before its
first insurance (`BrokerId` PK, `Amount`, `EffectiveDate`, `UpdatedBy`). A
broker created with an opening balance gets its row at creation. Without a row
the stored `brokers.CashBalance` is the only base and is maintained by the
incremental updates; with one, the balance is rebuilt from the formula below
after every change.

`broker_payments` — money the broker actually handed over: a branch top-up
(`increase`), a paid bill (`increase`) or a hand-over to the owner (`handover`).
The balance formula reads **this** table for payments, never the
`broker_balance_movements` ledger, so correcting a history row cannot silently
move a balance. The one thing it takes from the ledger is the VOID: a
policy-derived row an admin soft-deleted stops being charged (see the broker
balance rules). Each payment is also written to the ledger in the same
transaction (`MovementId` ties the two rows) for the history page, Cash from
Brokers and the reports; `db/setup.js` mirrors existing ledger payments once,
idempotently.

```
CashBalance = starting balance
            + SUM(broker_payments.Amount)          (live rows)
            - SUM(live insurances.Price)           (annulled: the annulment tax,
                                                    only when the broker paid it)
            - SUM(hidden policy rows.Amount)       (voids: charges removed from
                                                    the history of a live policy,
                                                    never of a deleted one)
```

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
| `Deleted`          | `TINYINT(1)`    | `1` = soft-deleted (with `DeletedAt` / `DeletedBy`) |
| `CreatedAt`        | `DATETIME`      | Creation time                     |

Use case: broker management. Admins/workers can increase/reduce a broker
balance or record a hand-over paid straight to the owner (which raises the
balance without touching the branches' Cash from Brokers). Creating an
insurance resolves its broker from the sender email (broker_emails) and deducts
a flat fee (the full Price) from its balance while decrementing
InactivePolicies. No percentages are used anywhere.

### `broker_emails`

Email addresses attached to a broker (one broker → many emails).

| Column     | Type           | Notes              |
| ---------- | -------------- | ------------------ |
| `id`       | `INT`          | Auto-increment PK  |
| `BrokerId` | `INT`          | FK to `brokers.id` |
| `Email`    | `VARCHAR(255)` | Email address      |

Use case: stores the multiple contact emails of each broker.

### `branches`

Managed branch registry. Admins can enable/disable a branch and create new
ones from the dashboard.

| Column      | Type           | Notes                                          |
| ----------- | -------------- | ---------------------------------------------- |
| `id`        | `INT`          | Auto-increment PK                              |
| `Name`      | `VARCHAR(100)` | Unique branch name                             |
| `Enabled`   | `TINYINT(1)`   | `1` = on, `0` = off                            |
| `CreatedAt` | `DATETIME`     | Creation time                                  |

Use case: turning a branch off forbids employees from logging in through that
branch and blocks the creation of new insurances through it. Every broker is
now serviced by every available branch (email cards are no longer restricted by
branch).

### `broker_bills`

One row per broker and payment period (two weeks, see
`Requests/PaymentSchedule.js`): what the broker owes for the insurances created
for them inside that period.

| Column              | Type           | Notes                                              |
| ------------------- | -------------- | -------------------------------------------------- |
| `id`                | `INT`          | Auto-increment PK                                  |
| `BrokerId`          | `INT`          | FK to `brokers.id`                                 |
| `PeriodStart`       | `DATE`         | First day of the period                            |
| `PeriodEnd`         | `DATE`         | Last day of the period (inclusive)                 |
| `Currency`          | `VARCHAR(3)`   | Always `EUR` (the broker business is in euros)      |
| `Charges`           | `DECIMAL(15,2)`| Policies summed (annulled at their annulled price) |
| `Refund`            | `DECIMAL(15,2)`| Remaining cash of earlier, PAID policies annulled now |
| `Amount`            | `DECIMAL(15,2)`| Due = `Charges - Refund` (charged price for a sub) |
| `PolicyCount`       | `INT`          | Policies in the period                             |
| `AnnulledCount`     | `INT`          | How many of them are annulled                      |
| `CarriedOver`       | `DECIMAL(15,2)`| Balance owed when the period started (information) |
| `CostToUs`/`Profit` | `DECIMAL(15,2)`| Sub-brokers: what the main broker pays us / keeps  |
| `ParentBrokerId`    | `INT`          | Sub-brokers: the main broker the bill is mailed to |
| `Status`            | `VARCHAR(20)`  | `open` / `paid`                                    |
| `Breakdown`         | `LONGTEXT`     | JSON: by type, refund lines, sub-broker block      |
| `EmailedAt`/`Emails`| `DATETIME`/`VARCHAR(1000)` | When and to whom the Excel file was sent |
| `MailAttempts`/`MailError` | `INT`/`VARCHAR(255)` | Failed send attempts and the last error |
| `PaidAt`/`PaidBy`   | `DATETIME`/`VARCHAR(45)` | Who confirmed the payment, when          |
| `PaymentType`       | `VARCHAR(20)`  | `increase` (cash at a branch) / `handover` (owner) |
| `PaymentCurrency`/`Branch` | `VARCHAR(3)`/`VARCHAR(45)` | Where the money was taken         |
| `OriginalAmount`/`AdjustReason` | `DECIMAL(15,2)`/`VARCHAR(255)` | An admin corrected the bill |
| `AdjustedBy`/`AdjustedAt` | `VARCHAR(45)`/`DATETIME` | Who corrected it, when                |

`UNIQUE (BrokerId, PeriodStart)` makes closing a period twice harmless.

Use case: bi-weekly broker billing. **The feature ships switched off**: no bill
is created, mailed or paid until the server runs with `BILLING_ENABLED=1`, so
every broker can be audited first with
`GET /brokers/bills/audit?periodStart=YYYY-MM-DD` (read-only). See `billing.md`
in the client repository for the mails, the audit steps and the open billing
questions.

## Run the server

```bash
npm start
```

The server listens on `http://127.0.0.1:5501`.

It exposes the REST API and the WebSocket only. The broker website is hosted
separately (see the `InsuranceWebsite` repository) and talks to this server
through `API_BASE`.

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
  `POST /admin/users/:username/restore`,
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
- `POST /currentcash/reduce` — body `{ "amount": 20, "reason": "..." }`. The
  "Expense" button of the app: the money leaves the drawer, is counted as an
  expense and lowers Total daily cash.
- `POST /currentcash/handover` — body
  `{ "amount": 40, "reason": "Runner to the safe", "recipient": "Ivan" }`. Both
  the reason and the person who took the money are required. The drawer
  (Available cash) drops, but no Total cash row is written: a hand-over is
  neither a sale nor an expense, so Total daily cash and the day's expenses are
  untouched. Stored as `Type = 'handover'` with `Recipient`, and listed in the
  day's Transactions.
- `POST /currentcash/reset` — reset the balance to `0` (records user + kept amount)
- `PATCH /currentcash/transactions/:id` — correct a ledger entry (only its own
  author may do this). A hand-over may be corrected (amount, currency, reason,
  recipient) but its type cannot be changed to/from `increase`/`reduce`, so
  money never silently moves between the expenses and Total daily cash.
- `DELETE /currentcash/transactions/:id` — soft-delete a ledger entry (admin
  only). The row is kept in `cash_transactions`, flagged with
  `Deleted`/`DeletedAt`/`DeletedBy`, and its money is reversed: an `increase` is
  taken back off the drawer, a `reduce` (or a `handover`) is put back in, with a
  matching `Delete of cash transaction #<id>` row in the Total cash ledger (none
  for a hand-over, which never had one). A reversal the
  drawer cannot fund (a `reduction` whose money was already spent or reset) is
  rejected with `400` and nothing changes. Deleted entries are excluded from
  `GET /currentcash`, from the day's expenses, from the daily report's cash net
  and from the historical balance walk, so the drawer and the ledger stay in
  step.

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

A broker balance never moves current cash:

- `POST /brokers/:id/increase` is money handed over by the broker. It is kept
  apart from current cash as the branch's **Cash from Brokers** (see below).
- `POST /brokers/:id/handover` is money the broker paid straight to the OWNER.
  It raises the broker's balance and counts as a payment (in
  `GET /reports/cash-inflow` and in the broker's last-payment date), but it
  carries no branch, so it is **never** Cash from Brokers and writes nothing to
  the cash drawer.
- The automatic per-policy deduction made when an insurance is created from an
  email card touches neither current cash nor Cash from Brokers, and is never
  blocked by how much cash happens to be available.
- There is no manual reduction. The balance is
  `starting balance + payments - the broker's live policies - voids` (an
  annulled policy at its annulment tax only when the broker paid it; a void is a
  policy row an admin deleted from the history). It is rebuilt from that source
  data after EVERY change that can move it - a policy created, edited, annulled,
  restored or deleted; a top-up, a hand-over or a paid bill; a correction or
  delete of a payment from the history page; a policy row deleted or restored
  from the history page; a starting balance saved - inside the same transaction
  as the change (see `refreshBrokerBalance` in `Requests/Brokers.js`), plus once
  on every start-up for brokers that have a starting balance. So `GET /brokers`,
  the broker's balance history and the bi-weekly figures all show the same
  figure.
- The money is read from `broker_payments` (a broker's top-ups, hand-overs and
  paid bills), never from `broker_balance_movements`: that ledger is the pure
  history of who did what, when, and no balance calculation adds it up. Each
  payment is still written to both tables in the same transaction (`MovementId`
  ties them), so the history page, Cash from Brokers and the reports keep reading
  the ledger. `db/setup.js` creates `broker_payments` and mirrors the payments
  already in the ledger once.
- That history is patched by the server itself, on every change that produces or
  alters it, in the same transaction: a policy charge (`policy`), a price
  correction (`price_change`), an annulment refund (`annulment`) and a deletion
  refund (`deletion`) are written when the policy is created, re-priced,
  annulled/restored, deleted/restored or moved between brokers, and a blanc
  correction carries a policy's rows to the new number with it.
- Deleting such a row from the balance history is a VOID and the balance honours
  it: `DELETE /brokers/:id/history/:movementId` on a policy row stops the broker
  being charged for that policy (hiding a refund instead keeps the money with the
  broker, i.e. the charge stays), and the rebuilt balance in the same transaction
  follows. `POST …/restore` charges it again. Only rows of a policy that still
  exists count: a soft-deleted insurance is charged nothing, and ALL of its
  history rows (hidden or not) are left out of the history page - the refund the
  deletion wrote may itself have been hidden, and a deleted policy must not leave
  a charge behind. The row itself is never removed and its amount/type/blanc
  cannot be rewritten by hand (`PATCH` accepts only `reason`/`author` on these
  rows): change the policy (price, annulment, deletion, blanc) and the server
  rewrites the rows. Money rows (`increase`/`handover`) stay editable and
  deletable, and the payments table follows them.
- The void is honoured by every figure built from the same charges, so they all
  agree: the daily report (`GET /currentcash/daily` - its `brokerBalance` and
  `totalDailyBalance`), `GET /reports/payments` (`brokerBalance`),
  `GET /reports/cash-inflow` (`totalOwed`) and the bi-weekly bills (`Charges`;
  a fully voided policy is left off the bill and a deleted annulment refund is
  not credited).
- The balance history page walks the movements forward from the stored starting
  balance, so the figures can be read with a pen: the first policy after a
  starting balance of -298 at 45 shows -343, and the newest row matches the
  Brokers tab. Without a starting balance there is no base, so the page walks
  back from the stored figure instead. Old `reduce`/`adjust` rows are kept as
  history: the page tags them as retired, they never move the balance, and an
  admin can soft-delete them without changing it.
- Every balance change is pushed to the connected clients (`broker_balance_changed`
  over the WebSocket), so an open Brokers tab or balance history re-reads the
  figure instead of showing a stale one.

### Cash from Brokers

Each top-up is stored once, as a `broker_balance_movements` row of type
`increase` carrying the `Branch` that took the money and its `Currency`. A
branch's Cash from Brokers is not a stored total: it is the sum of that
branch's top-ups recorded since its last reset, so correcting or deleting a
top-up in the broker's history corrects it here too. Refunds of annulled or
deleted insurances, price changes and admin balance edits are not money handed
over and are never counted. Nor is a hand-over to the owner (`handover`): that
money is a payment on the broker's balance, but it never reached a branch, so
it is excluded by both its type and its missing `Branch`.

- `GET /currentcash` returns `brokerCash` (the balance per currency),
  `brokerCashTransactions` (the top-ups of the requested day) and
  `brokerCashResets`.
- `GET /currentcash/daily` returns `cashFromBrokers` (the top-ups of the day).
  Its insurance money (`cashPayments`, `cardPayments`, `brokerBalance`,
  `totalDailyBalance`) counts a policy's current price, or the annulment tax once
  annulled, **plus whatever the admin removed from that policy's broker history**:
  a soft-deleted insurance is left out completely (its rows can neither charge
  nor void anything), and a hidden charge row of a live policy is a void exactly
  like in the broker balance - so the day's broker figure and the broker balances
  agree. Deleted cash entries are excluded from `availableCash`.
- `POST /currentcash/reset` also clears it, recording the kept amounts in
  `broker_cash_resets`.

Top-ups made before this was introduced have no branch and were mirrored into
current cash at the time. `db/setup.js` runs `db/separateBrokerCash.js` once on
start-up to move them over: it matches each of those top-ups to the current-cash
increase it was mirrored into, gives the movement that cash row's `Branch` and
`Currency`, deletes the mirrored cash row, shortens the resets that kept that
money (recording the kept amount in `broker_cash_resets`) and takes what is left
out of `current_cash` (never below zero). A top-up the migration cannot match -
its cash entry was edited into another amount, or it has no cash entry at all -
is left exactly as it was. The run is marked in `app_settings` as
`cash_from_brokers_backfill`, so it never repeats.

- `GET /brokers` — list all brokers with balance and inactive policies
  (`?includeDeleted=1`, admin only, also returns the soft-deleted ones as
  `deleted`, each with `DeletedAt`/`DeletedBy`)
- `GET /brokers/:id` — single broker
- `POST /brokers/:id/increase` — body `{ "amount": 100, "branch": "..." }` (the money is the branch's Cash from Brokers; current cash is not touched)
- `POST /brokers/:id/handover` — body `{ "amount": 100, "currency": "EUR", "reason": "..." }` (the broker paid the owner directly: the balance grows like a top-up and the reports count it as a payment, but no branch takes the money, so Cash from Brokers is untouched)

There is **no `POST /brokers/:id/reduce`** any more. A balance is raised only by
money the broker actually paid; it falls as policies are created and is
recalculated from the starting balance and the broker's policies (see
`PUT /brokers/:id/starting-balance`), so a hand-typed reduction would be undone
by the next recalculation. `reduce` and `adjust` rows that already exist stay in
`broker_balance_movements` as history: the balance history page tags them as
retired, they are left out of the total and the running balance, and soft
deleting/restoring one leaves `brokers.CashBalance` untouched.

Admin-only (`role 1`) broker management:

- `GET /brokers/export?format=json|csv` — extract all brokers (with emails and
  linked insurance counts) as JSON or a downloadable CSV
- `POST /brokers` — create a broker. The `CashBalance` it is created with is
  stored as its starting balance (dated the creation day), so the first
  recalculation starts from that figure instead of from 0
- `PATCH /brokers/:id` — update a broker's fields and/or its emails. The balance
  is NOT one of them any more: it is calculated (see
  `PUT /brokers/:id/starting-balance`), so a `CashBalance` sent by an older
  client is ignored instead of writing an `adjust` row, and its Name/Code/emails
  still save
- `DELETE /brokers/:id` — soft-delete a broker. The row is kept in `brokers`,
  flagged with `Deleted`/`DeletedAt`/`DeletedBy`, so its balance, blanc batches,
  emails, tariffs and linked policies are untouched; it is hidden from
  `GET /brokers` and the export, its addresses no longer resolve to a broker
  (`resolveBrokerByEmail`, so its emails are not shown), new insurances for it
  are rejected, and its live email claims are evicted
- `POST /brokers/:id/restore` — clear those flags, bringing the broker (with the
  balance and blancs it kept) back into every list
- `PUT /brokers/:id/starting-balance` — body `{ "amount": 250, "date": "2026-01-31" }`.
  Records the balance the broker had BEFORE its first insurance was created (the
  `date` is the day that balance belongs to and defaults to today) and
  recalculates `brokers.CashBalance` from the source data: the starting balance
  plus every payment the broker made (a branch top-up, `increase`, and a
  hand-over to the owner, `handover`) minus every live insurance of the broker,
  an annulled one at its annulment tax only when the broker paid that fee
  (`AnnulReason = 'broker'`). A `reduce` row (the retired "Reduce" button) and a
  legacy `adjust` row are NOT payments and are ignored, as are the
  policy-derived ledger rows - the insurances themselves are the truth for
  those, so a policy moved to another broker, an edited price or a soft-deleted
  movement cannot leave a stale charge behind. The same formula is re-applied to
  every broker with a stored starting balance when the server starts, so a
  corrected rule reaches figures that were stored under an older one.
  `GET /brokers/:id/history` returns the stored figure as `startingBalance: {
  amount, date, updatedBy, updatedAt }` (`null` until an admin sets one); the
  client shows it on the balance history page and recalculates when it is saved.

Each created insurance whose email sender is associated with a broker charges that broker a flat fee: the broker balance is reduced by the full Price (it may go infinitely negative, and this never touches current cash) and the broker InactivePolicies is decremented by 1.

## Broker billing (bi-weekly bills)

Every payment period (two weeks of `Requests/PaymentSchedule.js`) ends with one
**bill per broker**: the insurances created for that broker inside the period,
counted by vehicle type and summed. An annulled policy is billed at its annulled
price (`AnnulFee`), never at its original `Price`; a deleted one is not billed. A
charge whose history row the admin deleted (a void) is not billed either: the
broker's balance stops charging it, so the bill cannot ask for it - a policy
whose whole charge is voided is left off the bill, and an annulment refund that
was deleted is not credited. A policy that was billed and **paid** in an earlier
period and is annulled now gives the remaining cash (`Price - AnnulFee`) back as
a credit of the current period, so the amount due is `Charges - Refund`. Bills
are in **euros only**.

A **sub-broker is never mailed**: its bill is charged its display price (its own
`broker_tariffs`) and sent to its main broker, together with what we receive
(the stored `Price`) and the profit. The bill is stored in `broker_bills`,
turned into an Excel file (`Mail/brokerBillExcel.js` + `Mail/xlsxWriter.js`) and
mailed (`Mail/brokerBillMail.js`), with three selectable drafts
(`BILL_EMAIL_VARIANT=a|b|c`, `a` is the live one).

| Endpoint | Roles | Notes |
| --- | --- | --- |
| `GET /brokers/billing/settings` | 1, 2, 3 | `billingEnabled` + the current/closed period |
| `GET /brokers/bills/audit?periodStart=` | 1 | read-only: what each broker would be billed |
| `GET /brokers/bills?status=open\|paid` | 1 | all bills + the outstanding total |
| `POST /brokers/bills/close` | 1 | close a period now and mail the bills |
| `POST /brokers/bills/mail-pending` | 1 | retry the bills that were not delivered |
| `GET /brokers/:id/bills` | 1, 2, 3 | a broker's bills, the last unpaid one and the total owed |
| `POST /brokers/:id/bills/pay` | 1, 2 | confirm the payment of the unpaid bills |
| `POST /brokers/:id/bills/:billId/pay` | 1, 2 | confirm one bill |
| `PATCH /brokers/:id/bills/:billId` | 1 | `{ amount, reason?, sendMail? }` — correct a disputed bill and re-issue it |
| `POST /brokers/:id/bills/:billId/resend` | 1 | mail one bill again |

Paying a bill tags it `paid` and records the money in
`broker_balance_movements`, like the manual buttons: `increase` with a `Branch`
(cash at a branch, i.e. that branch's Cash from Brokers) or `handover` with no
branch (the owner took it). Both are payments for the reports.

**It ships switched off.** Nothing is billed, mailed or paid while the server
runs without `BILLING_ENABLED=1`; every write endpoint answers `409`. The first
run stores `app_settings.billing_auto_start` (the period current at that moment)
so no older period is ever billed automatically. Optional variables:
`BILLING_AUTO_START` (first period to bill), `BILL_EMAIL_VARIANT` (`a`, `b`, `c`),
`BILLING_CHECK_INTERVAL_MS` (default 15 min), `BILL_MAX_MAIL_ATTEMPTS` (default
3).

## Branches

Branches are managed from the admin dashboard's Branches tab. A disabled branch
blocks employee login and blocks the creation of new insurances through it.

- `GET /branches` — public list of enabled branches (for login branch pickers)
- Admin (`role 1`):
  - `GET /admin/branches` — list every branch (with `Enabled` state)
  - `POST /admin/branches` — create a branch (`{ "name": "..." }`)
  - `PATCH /admin/branches/:id` — enable/disable and/or rename a branch
    (`{ "enabled": true }` or `{ "name": "..." }`)

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
   `base64` is `null` for files larger than 10 MB, which are not inlined (the
   client shows the filename only).

## Gmail polling

Enabled by default when `.env` has valid OAuth credentials. It runs in the
background and does not block the REST/WebSocket server. Attachments are loaded
lazily and returned inline as base64; nothing is written to disk.

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

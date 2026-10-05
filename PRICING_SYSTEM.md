# Insurance Pricing System Documentation

## Overview

The insurance pricing system manages broker-specific and branch-wide (walk-in) pricing for insurance policies. It supports:

1. **Broker Tariffs** - Custom pricing per broker for each insurance type and duration
2. **Branch Tariffs** - Default "walk-in" pricing for each branch
3. **Secure Access Control** - Brokers can only view their own pricing; admins manage all tariffs
4. **Dynamic Updates** - Admins can update prices at any time; brokers poll on login to get latest rates

## Database Schema

### broker_tariffs Table

Stores custom pricing for each broker.

```sql
CREATE TABLE broker_tariffs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  BrokerId INT NOT NULL,
  InsuranceType VARCHAR(45) NOT NULL,    -- "Auto", "Motor", "Bus", "Trailer"
  Duration INT NOT NULL,                 -- days: 15, 30, 90
  Price DECIMAL(10,2) NOT NULL,
  CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UpdatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_broker_tariff (BrokerId, InsuranceType, Duration),
  KEY idx_broker_tariffs_broker (BrokerId)
);
```

### branch_tariffs Table

Stores walk-in pricing for each branch.

```sql
CREATE TABLE branch_tariffs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  Branch VARCHAR(100) NOT NULL,          -- branch name (e.g., "ГКПП Лесово")
  InsuranceType VARCHAR(45) NOT NULL,
  Duration INT NOT NULL,
  Price DECIMAL(10,2) NOT NULL,
  CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UpdatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch_tariff (Branch, InsuranceType, Duration),
  KEY idx_branch_tariffs_branch (Branch)
);
```

## API Endpoints

### Broker Endpoints (Clients)

#### GET /tariffs/my-pricing

Fetch the authenticated broker's own pricing tariffs.

**Authentication:** Required (any authenticated user)
**Access Control:** Brokers can only fetch their own pricing (username = broker name)

**Response:**

```json
{
  "brokerName": "Ahmed",
  "brokerId": 1,
  "pricing": {
    "Auto": {
      "15": 21,
      "30": 26,
      "90": 32
    },
    "Motor": {
      "30": 25,
      "90": 55
    },
    "Bus": {
      "30": 40,
      "90": 50
    },
    "Trailer": {
      "30": 89,
      "90": 99
    }
  }
}
```

**Use Case:** Brokers poll this endpoint when they log in to update client-side pricing cache.

---

### Admin Endpoints (Workers/Admins Only)

#### GET /tariffs/broker/:brokerId

View a specific broker's tariffs.

**Authentication:** Required
**Access Control:** Workers (role 2) and Admins (role 1) only

**Parameters:**

- `brokerId` (path): Broker ID

**Response:**

```json
{
  "brokerName": "Ahmed",
  "brokerId": 1,
  "pricing": { ... }
}
```

---

#### PATCH /tariffs/broker/:brokerId

Update a single tariff for a broker.

**Authentication:** Required
**Access Control:** Admins (role 1) only

**Parameters:**

- `brokerId` (path): Broker ID

**Request Body:**

```json
{
  "insuranceType": "Auto",
  "duration": 30,
  "price": 27.5
}
```

**Response:**

```json
{
  "message": "Broker tariff updated",
  "brokerId": 1,
  "insuranceType": "Auto",
  "duration": 30,
  "price": 27.5
}
```

---

#### POST /tariffs/broker/:brokerId/bulk

Bulk update multiple tariffs for a broker.

**Authentication:** Required
**Access Control:** Admins (role 1) only

**Parameters:**

- `brokerId` (path): Broker ID

**Request Body:**

```json
{
  "tariffs": [
    {
      "insuranceType": "Auto",
      "duration": 15,
      "price": 22
    },
    {
      "insuranceType": "Auto",
      "duration": 30,
      "price": 27
    },
    {
      "insuranceType": "Auto",
      "duration": 90,
      "price": 33
    },
    {
      "insuranceType": "Motor",
      "duration": 30,
      "price": 26
    },
    {
      "insuranceType": "Motor",
      "duration": 90,
      "price": 56
    }
  ]
}
```

**Response:**

```json
{
  "message": "Broker tariffs updated",
  "brokerId": 1,
  "count": 5
}
```

---

### Branch Walk-In Tariffs

#### GET /tariffs/branch/:branchName

Get walk-in pricing for a specific branch.

**Authentication:** Required
**Access Control:** Any authenticated user

**Parameters:**

- `branchName` (path, URL-encoded): Branch name

**Example:** `/tariffs/branch/ГКПП%20Лесово`

**Response:**

```json
{
  "branch": "ГКПП Лесово",
  "pricing": {
    "Auto": {
      "15": 25,
      "30": 35,
      "90": 40
    },
    "Motor": {
      "30": 26,
      "90": 57
    },
    "Bus": {
      "30": 40,
      "90": 50
    },
    "Trailer": {
      "30": 89,
      "90": 99
    }
  }
}
```

---

#### PATCH /tariffs/branch/:branchName

Update a single walk-in tariff for a branch.

**Authentication:** Required
**Access Control:** Admins (role 1) only

**Parameters:**

- `branchName` (path, URL-encoded): Branch name

**Request Body:**

```json
{
  "insuranceType": "Auto",
  "duration": 30,
  "price": 36
}
```

**Response:**

```json
{
  "message": "Branch tariff updated",
  "branch": "ГКПП Лесово",
  "insuranceType": "Auto",
  "duration": 30,
  "price": 36
}
```

---

#### POST /tariffs/branch/:branchName/bulk

Bulk update multiple tariffs for a branch.

**Authentication:** Required
**Access Control:** Admins (role 1) only

**Parameters:**

- `branchName` (path, URL-encoded): Branch name

**Request Body:** (same format as broker bulk update)

**Response:**

```json
{
  "message": "Branch tariffs updated",
  "branch": "ГКПП Лесово",
  "count": 9
}
```

---

## Broker Data Seeding

### How Brokers Are Seeded

On application startup, `db/setup.js` calls `seedBrokersFromInfo()` from `db/BrokerInfo.js` to:

1. Create broker records with names from `BrokerInfo.js`
2. Link all email addresses to each broker
3. Populate initial pricing tariffs from the `Pricing` object

### The BrokerInfo.js Structure

```javascript
// Email lists per broker
let Ahmed = ["derincorlu@gmail.com", ...];
let Yuksel = ["yukselfenerli@gmail.com"];
...

// Pricing tariffs per broker
let Pricing = {
  Ahmed: {
    Auto: { 15: 21, 30: 26, 90: 32 },
    Motor: { 30: 25, 90: 55 },
    Bus: { 30: 40, 90: 50 },
    Trailer: { 30: 89, 90: 99 }
  },
  ...
};

// Mapping of broker names to emails
const BrokerData = {
  Ahmed: Ahmed,
  Yuksel: Yuksel,
  ...
};
```

The seeding is **idempotent**: brokers are only inserted if they don't already exist. Existing brokers are never overwritten unless explicitly updated via the admin API.

---

## Pricing Workflow

### 1. Initial Setup (Automatic)

```
Application Start
  ↓
db/setup.js runs
  ↓
seedBrokersFromInfo() executes
  ↓
All brokers from BrokerInfo.js are seeded with:
  - Broker records
  - Email mappings
  - Initial pricing tariffs
```

### 2. Broker Login (Client-Side)

```
Broker logs in
  ↓
Client calls GET /tariffs/my-pricing
  ↓
Server returns broker's current tariffs
  ↓
Client caches pricing locally
  ↓
Client uses cached prices for insurance form
```

### 3. Admin Price Update

```
Admin wants to update prices
  ↓
Admin calls PATCH or POST /tariffs/broker/:id
  ↓
Server updates broker_tariffs table
  ↓
Next broker login polls GET /tariffs/my-pricing
  ↓
Client gets updated prices
```

---

## Security & Access Control

### Role-Based Access

| Endpoint                        | Role 1 (Admin) | Role 2 (Worker) | Role 3 (Broker/Client) |
| ------------------------------- | -------------- | --------------- | ---------------------- |
| GET /tariffs/my-pricing         | ✓              | ✓               | ✓ (own only)           |
| GET /tariffs/broker/:id         | ✓              | ✓               | ✗                      |
| PATCH /tariffs/broker/:id       | ✓              | ✗               | ✗                      |
| POST /tariffs/broker/:id/bulk   | ✓              | ✗               | ✗                      |
| GET /tariffs/branch/:name       | ✓              | ✓               | ✓                      |
| PATCH /tariffs/branch/:name     | ✓              | ✗               | ✗                      |
| POST /tariffs/branch/:name/bulk | ✓              | ✗               | ✗                      |

### Broker Data Isolation

- Brokers cannot access `/tariffs/broker/:id` endpoints
- Brokers can only retrieve their own pricing via `/tariffs/my-pricing`
- The endpoint uses `req.user.username` (must match broker name) to prevent cross-broker access
- Attempting to access another broker's pricing returns `404: Broker not found`

### Email-to-Broker Mapping

When a policy is created via email (in `ProcessEmail.js`):

1. Email sender is extracted from the message header
2. `resolveBrokerByEmail()` in `Brokers.js` looks up the email in `broker_emails` table
3. The corresponding broker is identified
4. Policy is tagged with that broker's ID
5. Broker pricing is applied

---

## Example Usage

### For Broker Client (e.g., Electron App)

```javascript
// On login
async function fetchPricing(token) {
  const response = await fetch("http://localhost:5501/tariffs/my-pricing", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  localStorage.setItem("brokerPricing", JSON.stringify(data.pricing));
  return data.pricing;
}

// When creating insurance policy
function getPriceForPolicy(insuranceType, duration) {
  const cachedPricing = JSON.parse(localStorage.getItem("brokerPricing"));
  return cachedPricing[insuranceType][duration];
}
```

### For Admin Interface

```javascript
// Update a single broker's tariff
async function updateBrokerPrice(brokerId, insuranceType, duration, price) {
  const response = await fetch(
    `http://localhost:5501/tariffs/broker/${brokerId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        insuranceType,
        duration: parseInt(duration),
        price: parseFloat(price),
      }),
    }
  );
  return response.json();
}

// Bulk update all Auto prices for a broker
async function bulkUpdateBrokerPrices(brokerId, tariffs) {
  const response = await fetch(
    `http://localhost:5501/tariffs/broker/${brokerId}/bulk`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ tariffs }),
    }
  );
  return response.json();
}

// Update branch walk-in pricing
async function updateBranchWalkInPrice(
  branchName,
  insuranceType,
  duration,
  price
) {
  const encodedBranch = encodeURIComponent(branchName);
  const response = await fetch(
    `http://localhost:5501/tariffs/branch/${encodedBranch}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        insuranceType,
        duration: parseInt(duration),
        price: parseFloat(price),
      }),
    }
  );
  return response.json();
}
```

---

## Future Enhancements

1. **Users-Brokers Mapping Table** - Currently uses `username === broker name`. Could be improved with:

   - Separate `users_brokers` junction table
   - Multiple users per broker
   - Role assignments per user-broker pair

2. **Price History** - Track pricing changes over time:

   - Add `audit_log` for tariff changes
   - Record who changed what and when
   - Rollback capability

3. **Dynamic Pricing Rules** - Support conditional pricing:

   - Volume discounts
   - Seasonal rates
   - Customer-specific pricing
   - Early-bird rates

4. **Price Approval Workflow** - Admin approval process:

   - Brokers request price changes
   - Admins review and approve/reject
   - Automatic notification system

5. **Pricing Tiers** - Multiple pricing levels:
   - Standard pricing
   - Preferred customer pricing
   - VIP pricing
   - Seasonal adjustments

---

## Troubleshooting

### Broker Can't Fetch Pricing

- **Check:** Is broker username in database matching broker name in `brokers` table?
- **Check:** Are tariffs inserted for the broker in `broker_tariffs` table?
- **Test:** `SELECT * FROM brokers WHERE Name = 'BrokerName';`

### Email-based Insurance Creation Fails

- **Check:** Is email address linked to broker in `broker_emails` table?
- **Check:** Is case sensitivity correct when comparing emails?
- **Test:** `SELECT * FROM broker_emails WHERE LOWER(Email) = LOWER('email@example.com');`

### Bulk Update Fails

- **Check:** Are all required fields present? (`insuranceType`, `duration`, `price`)
- **Check:** Are numeric fields properly formatted?
- **Test:** Validate JSON structure matches the examples above

---

## Migration Guide (For Existing Installations)

If you're upgrading an existing system:

1. **Backup your database:**

   ```bash
   mysqldump -u root -p insurancedb > backup.sql
   ```

2. **Run database setup:**

   ```bash
   npm run db:setup
   ```

3. **Verify brokers were seeded:**

   ```sql
   SELECT COUNT(*) FROM brokers;
   SELECT * FROM broker_tariffs LIMIT 10;
   ```

4. **Update your client app** to poll `/tariffs/my-pricing` on login

5. **Test with a broker login** to ensure pricing is fetched correctly

"use strict";

// ---------------------------------------------------------------------------
// Company bank account (admin only)
//
// The bank account is a MONTHLY balance. It is built from money the branches
// actually sent to the company bank:
//
//   + available cash kept at the end of a shift  (`cash_resets.KeptAmount`)
//   + manual cash increases to brokers           (`broker_balance_movements`
//     rows of Type = 'increase' that carry a branch)
//   - money handed over out of the bank          (`bank_handovers`)
//
// A manual broker increase is booked by the branch during the day but reaches
// the bank only when that day closes: at 00:00 the next day. The current
// month's figure therefore counts increases from earlier days only, exactly as
// the daily close does. Past months are complete.
//
// The balance is derived, never stored, so it starts again from zero on the
// first day of each month while every earlier month remains available in
// `history`. The only new table, `bank_handovers`, records money that LEFT the
// bank; those rows are kept (soft-deleted rows included) for the history.
// ---------------------------------------------------------------------------

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const {
  clientLocalDateTime,
  normalizeCurrency,
  resolveRequestCreatedAt,
  toDecimal,
} = require("./CurrentCash.js");

const CURRENCIES = ["EUR", "TRY"];

const BANK_HANDOVERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS bank_handovers (
    id INT NOT NULL AUTO_INCREMENT,
    Amount DECIMAL(15,2) NOT NULL,
    Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    Recipient VARCHAR(100) NOT NULL,
    Reason VARCHAR(255) NOT NULL DEFAULT '',
    Author VARCHAR(45) NOT NULL DEFAULT '',
    CreatedAt DATETIME NOT NULL,
    Deleted TINYINT(1) NOT NULL DEFAULT 0,
    DeletedAt DATETIME NULL,
    DeletedBy VARCHAR(45) NULL,
    PRIMARY KEY (id),
    KEY idx_bank_handovers_created (CreatedAt),
    KEY idx_bank_handovers_currency (Currency)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Money handed over out of the company bank account'
`;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function emptyTotals() {
  const totals = {};
  for (const currency of CURRENCIES) totals[currency] = 0;
  return totals;
}

function addMoney(target, currency, amount) {
  const cur = normalizeCurrency(currency);
  target[cur] = roundMoney((target[cur] || 0) + (Number(amount) || 0));
  return target;
}

function monthOf(value) {
  const text = String(value || "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : null;
}

// SQL bounds of one calendar month: [first day 00:00, first day of next month).
function monthBounds(month) {
  const [year, mon] = month.split("-").map(Number);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;
  const pad = (n) => String(n).padStart(2, "0");
  return [
    `${month}-01 00:00:00`,
    `${nextYear}-${pad(nextMonth)}-01 00:00:00`,
  ];
}

/** Create `bank_handovers` when it does not exist yet (idempotent). */
async function ensureBankHandoversTable(db) {
  await db.query(BANK_HANDOVERS_TABLE_SQL);
}

async function sumByCurrency(db, sql, params) {
  const [rows] = await db.query(sql, params);
  const totals = emptyTotals();
  for (const row of rows || []) addMoney(totals, row.Currency, row.Total);
  return totals;
}

function sumTotals(first, second) {
  const totals = emptyTotals();
  for (const currency of CURRENCIES) {
    totals[currency] = roundMoney(
      (Number(first && first[currency]) || 0) +
        (Number(second && second[currency]) || 0)
    );
  }
  return totals;
}

function subtractTotals(first, second) {
  const totals = emptyTotals();
  for (const currency of CURRENCIES) {
    totals[currency] = roundMoney(
      (Number(first && first[currency]) || 0) -
        (Number(second && second[currency]) || 0)
    );
  }
  return totals;
}

/**
 * The bank account of one month plus the history of every month with activity.
 *
 * @param {object} db  Pool or connection (needs `.query`).
 * @param {{ month?: string, tzOffset?: unknown }} options
 */
async function getBankReport(db, options = {}) {
  await ensureBankHandoversTable(db);

  const today = clientLocalDateTime(options.tzOffset);
  const todayDay = today.slice(0, 10);
  const todayStart = `${todayDay} 00:00:00`;
  const currentMonth = today.slice(0, 7);
  const month = monthOf(options.month) || currentMonth;
  const [start, end] = monthBounds(month);

  const cashSql = `SELECT Currency, ROUND(SUM(KeptAmount), 2) AS Total
                     FROM cash_resets
                    WHERE CreatedAt >= ? AND CreatedAt < ?
                    GROUP BY Currency`;
  // Manual increases to a broker balance are cash the broker paid the branch.
  // A day's increases reach the bank at 00:00 the next day, so the current
  // month never counts today's rows yet.
  const brokerSql = `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
                       FROM broker_balance_movements
                      WHERE Type = 'increase' AND Deleted = 0 AND Amount > 0
                        AND Branch IS NOT NULL
                        AND Branch <> ''
                        AND CreatedAt >= ? AND CreatedAt < ?
                        AND CreatedAt < ?
                      GROUP BY Currency`;
  const bankSql = `SELECT Currency, ROUND(SUM(Amount), 2) AS Total
                     FROM bank_handovers
                    WHERE Deleted = 0 AND CreatedAt >= ? AND CreatedAt < ?
                    GROUP BY Currency`;

  const cashKept = await sumByCurrency(db, cashSql, [start, end]);
  const brokerIncreases = await sumByCurrency(db, brokerSql, [
    start,
    end,
    todayStart,
  ]);
  const handedOver = await sumByCurrency(db, bankSql, [start, end]);
  const deposits = sumTotals(cashKept, brokerIncreases);
  const balance = subtractTotals(deposits, handedOver);

  // Month-by-month history. The broker increases are capped at today's 00:00
  // for the same reason as above; every earlier month is complete.
  const [cashMonths] = await db.query(
    `SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month, Currency,
            ROUND(SUM(KeptAmount), 2) AS Total
       FROM cash_resets
      GROUP BY DATE_FORMAT(CreatedAt, '%Y-%m'), Currency`
  );
  const [brokerMonths] = await db.query(
    `SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month, Currency,
            ROUND(SUM(Amount), 2) AS Total
       FROM broker_balance_movements
      WHERE Type = 'increase' AND Deleted = 0 AND Amount > 0
        AND Branch IS NOT NULL
        AND Branch <> ''
        AND CreatedAt < ?
      GROUP BY DATE_FORMAT(CreatedAt, '%Y-%m'), Currency`,
    [todayStart]
  );
  const [bankMonths] = await db.query(
    `SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month, Currency,
            ROUND(SUM(Amount), 2) AS Total
       FROM bank_handovers
      WHERE Deleted = 0
      GROUP BY DATE_FORMAT(CreatedAt, '%Y-%m'), Currency`
  );

  const byMonth = new Map();
  const bucket = (key) => {
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        Month: key,
        CashKept: emptyTotals(),
        BrokerIncreases: emptyTotals(),
        HandedOver: emptyTotals(),
        Balance: emptyTotals(),
      });
    }
    return byMonth.get(key);
  };
  for (const row of cashMonths || []) {
    addMoney(bucket(String(row.Month)).CashKept, row.Currency, row.Total);
  }
  for (const row of brokerMonths || []) {
    addMoney(
      bucket(String(row.Month)).BrokerIncreases,
      row.Currency,
      row.Total
    );
  }
  for (const row of bankMonths || []) {
    addMoney(bucket(String(row.Month)).HandedOver, row.Currency, row.Total);
  }
  const history = [...byMonth.values()]
    .sort((a, b) => String(b.Month).localeCompare(String(a.Month)))
    .map((entry) => ({
      ...entry,
      Balance: subtractTotals(
        sumTotals(entry.CashKept, entry.BrokerIncreases),
        entry.HandedOver
      ),
    }));

  const [handoverRows] = await db.query(
    `SELECT id, Amount, Currency, Recipient, Reason, Author, CreatedAt
       FROM bank_handovers
      WHERE Deleted = 0 AND CreatedAt >= ? AND CreatedAt < ?
      ORDER BY id DESC`,
    [start, end]
  );

  return {
    month,
    today: todayDay,
    deposits,
    cashKept,
    brokerIncreases,
    handedOver,
    balance,
    history,
    handovers: (handoverRows || []).map((row) => ({
      ...row,
      Amount: roundMoney(row.Amount),
      Currency: normalizeCurrency(row.Currency),
    })),
  };
}


module.exports.createBankRouter = function createBankRouter(DBConnection) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireAdmin = requireRole(1);

  // GET /bank?month=YYYY-MM&tzOffset=N — monthly balance, history and the
  // month's hand-overs. Admin only: the bank account is never shown to workers.
  router.get("/bank", auth, requireAdmin, async (req, res) => {
    try {
      const report = await getBankReport(DBConnection, {
        month: req.query.month,
        tzOffset: req.query.tzOffset,
      });
      res.json(report);
    } catch (err) {
      console.error("Bank account lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch bank account" });
    }
  });

  // POST /bank/handover — hand money over OUT of the company bank account.
  router.post("/bank/handover", auth, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const amount = toDecimal(b.amount ?? b.Amount);
      if (amount === null || amount <= 0) {
        return res
          .status(400)
          .json({ error: "amount must be a positive number" });
      }
      const recipient = String(b.Recipient ?? b.recipient ?? "").trim();
      if (!recipient) {
        return res.status(400).json({ error: "recipient is required" });
      }
      const reason = String(b.reason ?? b.Reason ?? "").trim();
      const currency = normalizeCurrency(b.currency ?? b.Currency);
      const created = resolveRequestCreatedAt(b);
      if (created.error) {
        return res.status(400).json({ error: created.error });
      }

      await ensureBankHandoversTable(DBConnection);
      await DBConnection.query(
        `INSERT INTO bank_handovers
           (Amount, Currency, Recipient, Reason, Author, CreatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          roundMoney(amount),
          currency,
          recipient,
          reason,
          String((req.user && req.user.username) || ""),
          created.createdAt,
        ]
      );
      res.json({ message: "Bank hand-over recorded" });
    } catch (err) {
      console.error("Bank hand-over failed:", err);
      res.status(500).json({ error: "Failed to record bank hand-over" });
    }
  });

  return router;
};

module.exports.getBankReport = getBankReport;
module.exports.ensureBankHandoversTable = ensureBankHandoversTable;
module.exports.BANK_HANDOVERS_TABLE_SQL = BANK_HANDOVERS_TABLE_SQL;
module.exports.monthBounds = monthBounds;


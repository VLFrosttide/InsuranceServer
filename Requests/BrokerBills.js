"use strict";
// Bi-weekly broker bills over HTTP.
//
//   GET  /brokers/bills?status=open|paid|all      (admin)   every unpaid bill
//   POST /brokers/bills/close                     (admin)   close a period + mail
//
//   GET  /brokers/:id/bills                                 one broker's bills,
//                                                           newest first, with the
//                                                           outstanding total
//   POST /brokers/:id/bills/pay                             confirm a payment:
//                                                           the unpaid bills are
//                                                           tagged paid and the
//                                                           money is recorded on the
//                                                           broker's balance ledger
//   POST /brokers/:id/bills/:billId/pay                     pay one bill only
//   POST /brokers/:id/bills/:billId/resend        (admin)   mail the bill again
//
// A bill is created by the bi-weekly run (Mail/brokerBilling.js) or by the
// admin "close period" request, never by a payment.
//
// Paying: a bill is what the broker owes for one period, so confirming it is
// money received. It is written to `broker_balance_movements` exactly like the
// manual "Increase" / "Hand over" buttons do:
//   * paymentType "increase" (default) - the money was handed over at a branch,
//     so it also becomes that branch's Cash from Brokers (a `branch` is
//     required, the client sends the worker's branch);
//   * paymentType "handover" - the owner took it outside the branches, so it
//     carries no branch and never counts as Cash from Brokers.
// Both raise the broker's balance, which is what settles the bill, and both are
// counted as a payment by the reports (they read 'increase' and 'handover').

const express = require("express");
const { requireAuth, requireRole } = require("./Auth.js");
const {
  normalizeBranch,
  clientLocalDateTime,
  parseClientDateTime,
} = require("./CurrentCash.js");
const { getSchedule, lastClosedPeriod } = require("./PaymentSchedule.js");
const { recordBrokerMovement } = require("./Brokers.js");
const bills = require("../db/brokerBills.js");
const {
  sendPendingBills,
  closePeriodNow,
} = require("../Mail/brokerBilling.js");
const { sendBillMail } = require("../Mail/brokerBillMail.js");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseId(param) {
  const id = Number(param);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// The CreatedAt of a payment: the client's own wall clock when it sent one,
// otherwise the server clock shifted by its time zone offset. Same rule as the
// manual balance movements (see Brokers.resolveBrokerCreatedAt).
function resolvePaidAt(body) {
  const b = body || {};
  const sent = b.CreatedAt ?? b.createdAt;
  if (sent !== undefined && sent !== null && sent !== "") {
    const parsed = parseClientDateTime(sent);
    return parsed || null;
  }
  return clientLocalDateTime(b.TzOffset ?? b.tzOffset ?? null);
}

/**
 * Create the broker-bills router.
 *
 * @param {import("mysql2/promise").Connection} DBConnection
 * @returns {import("express").Router}
 */
module.exports.createBrokerBillsRouter = function createBrokerBillsRouter(
  DBConnection
) {
  const router = express.Router();
  const auth = requireAuth(DBConnection);
  const requireBrokerRole = requireRole(1, 2);
  const requireAdmin = requireRole(1);

  // Admins and workers see every broker; a broker-linked client (3) only its
  // own. Sets req.brokerScope to null (full access) or a broker id.
  const requireBrokerView = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const role = String(req.user.role);
    if (role === "1" || role === "2") {
      req.brokerScope = null;
      return next();
    }
    if (role === "3") {
      const brokerId = req.user.brokerId ? Number(req.user.brokerId) : null;
      if (!brokerId) {
        return res.status(403).json({
          error: "Forbidden: this account is not linked to a broker",
        });
      }
      req.brokerScope = brokerId;
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  };

  // Billing is OFF until it is switched on: the code is deployed, the table and
  // the read endpoints exist, but nothing is billed, mailed or paid until
  // BILLING_ENABLED=1. That leaves room to audit every broker first (the audit
  // endpoint below writes nothing).
  function billingEnabled() {
    return String(process.env.BILLING_ENABLED ?? "0").trim() === "1";
  }

  function disabled(res) {
    return res.status(409).json({
      error:
        "Broker billing is not enabled yet. Audit the brokers first, then " +
        "set BILLING_ENABLED=1 on the server.",
      billingEnabled: false,
    });
  }

  // GET /brokers/billing/settings — what the client needs to decide whether to
  // show the Payment button at all.
  router.get("/brokers/billing/settings", auth, requireBrokerView, (req, res) => {
    const now = new Date();
    res.json({
      billingEnabled: billingEnabled(),
      schedule: getSchedule(now),
      closedPeriod: lastClosedPeriod(now),
      emailVariant: String(process.env.BILL_EMAIL_VARIANT || "a"),
    });
  });

  // GET /brokers/bills/audit?periodStart=YYYY-MM-DD — what every broker WOULD be
  // billed for a period. Read-only: no bill is created and no mail is sent, so
  // the numbers can be checked broker by broker before billing goes live.
  router.get("/brokers/bills/audit", auth, requireAdmin, async (req, res) => {
    try {
      const raw = String(req.query.periodStart ?? "").trim();
      const periodStart = raw || lastClosedPeriod(new Date()).periodStart;
      if (!DATE_RE.test(periodStart)) {
        return res
          .status(400)
          .json({ error: "periodStart must be a YYYY-MM-DD date" });
      }
      const period = bills.periodFor(periodStart);

      const [brokerRows] = await DBConnection.query(
        `SELECT id, Name, Code, CashBalance, Deleted, ParentBrokerId
           FROM brokers ORDER BY Deleted, Name`
      );

      const rows = [];
      for (const broker of brokerRows || []) {
        const brokerId = Number(broker.id);
        // The same calculation the real bill uses, so the audit is exact.
        const figures = await bills.computeBillFigures(
          DBConnection,
          broker,
          period.periodStart,
          period.periodEnd
        );
        // Who the bill would reach: the broker itself, or its main broker for a
        // sub-broker (a sub-broker is never mailed).
        const target = await bills.loadMailTarget(DBConnection, brokerId);
        const existing = (await bills.loadBills(DBConnection, brokerId)).find(
          (b) => b.periodStart === period.periodStart
        );
        rows.push({
          brokerId,
          name: String(broker.Name || ""),
          code: String(broker.Code || ""),
          deleted: Boolean(Number(broker.Deleted)),
          isSub: Boolean(figures ? figures.isSub : target && target.isSub),
          parentBrokerId: target ? target.parentBrokerId : null,
          // Where the mail goes (`mailTo` names the main broker for a sub).
          emails: target ? target.emails : [],
          mailTo: target ? target.recipientName : "",
          subWithoutParent: target ? target.subWithoutParent : false,
          policies: figures ? figures.summary.policies : 0,
          annulled: figures ? figures.summary.annulled : 0,
          charges: figures ? figures.charges : 0,
          refund: figures ? figures.refund : 0,
          refunds: figures ? figures.refunds : [],
          // What the broker owes after the refund credit.
          total: figures ? figures.amount : 0,
          // Sub-brokers: charged to the sub, ours, and the main broker's profit.
          costToUs: figures ? figures.costToUs : null,
          profit: figures ? figures.profit : null,
          byType: figures ? figures.summary.byType : [],
          // Positive = owed when the period started (carried over).
          carriedOver: figures ? figures.carriedOver : 0,
          balanceNow: round2(broker.CashBalance),
          existingBill: existing
            ? {
                id: existing.id,
                status: existing.status,
                amount: existing.amount,
                originalAmount: existing.originalAmount,
              }
            : null,
        });
      }

      res.json({
        period,
        billingEnabled: billingEnabled(),
        // Brokers that cannot receive a bill (no address, or a sub-broker with
        // no main broker) - the first thing to fix during the audit.
        withoutEmail: rows.filter((r) => !r.deleted && r.emails.length === 0)
          .length,
        brokers: rows,
      });
    } catch (err) {
      console.error("Broker bill audit failed:", err);
      res.status(500).json({ error: "Failed to audit broker bills" });
    }
  });


  // GET /brokers/bills?status=open|paid|all — every bill, for the admin screen.
  router.get("/brokers/bills", auth, requireAdmin, async (req, res) => {
    try {
      const status = String(req.query.status ?? "open").trim().toLowerCase();
      const filter = ["open", "paid"].includes(status)
        ? "WHERE b.Status = ?"
        : "";
      const params = filter ? [status] : [];
      const [rows] = await DBConnection.query(
        `SELECT b.*, br.Name AS BrokerName, br.Code AS BrokerCode
           FROM broker_bills b
           LEFT JOIN brokers br ON br.id = b.BrokerId
           ${filter}
          ORDER BY b.PeriodStart DESC, br.Name`,
        params
      );
      const list = (rows || []).map((row) => ({
        ...bills.serializeBill(row),
        brokerName: String(row.BrokerName || ""),
        brokerCode: String(row.BrokerCode || ""),
      }));
      res.json({
        status,
        billingEnabled: billingEnabled(),
        outstanding: bills.outstandingOf(list),
        bills: list,
      });
    } catch (err) {
      console.error("Broker bill list failed:", err);
      res.status(500).json({ error: "Failed to fetch broker bills" });
    }
  });

  // GET /brokers/:id/bills — the bills of one broker, newest period first, plus
  // what is still owed. This is what the client's Payment button reads.
  router.get("/brokers/:id/bills", auth, requireBrokerView, async (req, res) => {
    try {
      const brokerId = parseId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      if (req.brokerScope !== null && req.brokerScope !== brokerId) {
        return res
          .status(403)
          .json({ error: "Forbidden: you can only view your own broker" });
      }
      const [[broker]] = await DBConnection.query(
        "SELECT id, Name, Code, CashBalance FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (!broker) {
        return res.status(404).json({ error: "Broker not found" });
      }
      const list = await bills.loadBills(DBConnection, brokerId);
      const outstanding = bills.outstandingOf(list);
      res.json({
        broker: {
          id: Number(broker.id),
          Name: String(broker.Name || ""),
          Code: String(broker.Code || ""),
          CashBalance: round2(broker.CashBalance),
        },
        billingEnabled: billingEnabled(),
        period: lastClosedPeriod(new Date()),
        outstanding,
        // The last unpaid bill is the newest one: it is what the Payment button
        // shows first (the older open periods, if any, are paid together).
        lastUnpaid: list.find((b) => b.id === outstanding.lastUnpaidId) || null,
        bills: list,
      });
    } catch (err) {
      console.error("Broker bill lookup failed:", err);
      res.status(500).json({ error: "Failed to fetch broker bills" });
    }
  });


  // Confirm the payment of a broker's unpaid bills: each one is tagged paid and
  // the money is recorded on the broker's balance (see the note at the top).
  //
  // Body: { billIds?, paymentType?: "increase" | "handover", currency?,
  //         branch?, CreatedAt?, TzOffset? }
  async function confirmPayment(req, res, onlyBillId = null) {
    if (!billingEnabled()) return disabled(res);
    try {
      const brokerId = parseId(req.params.id);
      if (brokerId === null) {
        return res.status(400).json({ error: "Invalid broker id" });
      }
      const [[broker]] = await DBConnection.query(
        "SELECT id, Name, Code, CashBalance FROM brokers WHERE id = ?",
        [brokerId]
      );
      if (!broker) {
        return res.status(404).json({ error: "Broker not found" });
      }

      const open = await bills.loadBills(DBConnection, brokerId, {
        status: "open",
      });
      let selected = open;
      if (onlyBillId !== null) {
        selected = open.filter((b) => b.id === onlyBillId);
      } else if (Array.isArray(req.body?.billIds)) {
        const wanted = new Set(
          req.body.billIds.map((id) => Number(id)).filter((id) => id > 0)
        );
        selected = open.filter((b) => wanted.has(b.id));
      }
      if (selected.length === 0) {
        return res.status(400).json({
          error: "No unpaid bill for this broker",
          bills: open,
        });
      }

      const requested = String(
        req.body?.paymentType ?? req.body?.method ?? "increase"
      )
        .trim()
        .toLowerCase();
      const paymentType = requested === "handover" ? "handover" : "increase";
      // Bills are in euros only (the broker business runs in EUR), so a payment
      // is always recorded in EUR whatever the client sends.
      const currency = "EUR";
      // Cash taken at a branch is that branch's Cash from Brokers, so it must
      // name the branch. A hand-over to the owner never names one.
      const branch =
        paymentType === "increase"
          ? normalizeBranch(req.body?.branch ?? req.user?.branch ?? "")
          : "";
      if (paymentType === "increase" && !branch) {
        return res.status(400).json({
          error: "branch is required for a cash payment",
        });
      }
      const paidAt = resolvePaidAt(req.body);
      if (!paidAt) {
        return res.status(400).json({
          error: "CreatedAt must be in YYYY-MM-DD HH:MM:SS format",
        });
      }

      const paid = [];
      let total = 0;
      await DBConnection.withTransaction(async (conn) => {
        for (const bill of selected) {
          // Only an open bill is tagged, so two confirmations at once cannot
          // record the same bill (and its money) twice.
          const changed = await bills.markBillPaid(conn, bill.id, {
            paidAt,
            paidBy: req.user && req.user.username,
            paymentType,
            currency,
            branch,
          });
          if (!changed) continue;

          const amount = round2(bill.amount);
          if (amount > 0) {
            await recordBrokerMovement(conn, brokerId, amount, paymentType, {
              reason: `Bill ${bill.periodStart} .. ${bill.periodEnd} (#${bill.id})`,
              author: (req.user && req.user.username) || "",
              createdAt: paidAt,
              currency,
              ...(paymentType === "increase" ? { branch } : {}),
            });
            total = round2(total + amount);
          }
          paid.push({ ...bill, status: "paid", paidAt });
        }

        if (total !== 0) {
          await conn.query(
            "UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?",
            [total, brokerId]
          );
        }
      });

      const [[after]] = await DBConnection.query(
        "SELECT id, Name, Code, CashBalance FROM brokers WHERE id = ?",
        [brokerId]
      );

      res.json({
        message: "Payment confirmed",
        broker: {
          id: Number(after.id),
          Name: String(after.Name || ""),
          Code: String(after.Code || ""),
          CashBalance: round2(after.CashBalance),
        },
        total,
        currency,
        paymentType,
        branch: branch || null,
        paidAt,
        paid,
        bills: await bills.loadBills(DBConnection, brokerId),
      });
    } catch (err) {
      console.error("Broker bill payment failed:", err);
      res.status(500).json({ error: "Failed to confirm the payment" });
    }
  }


  // POST /brokers/:id/bills/pay — pay every unpaid bill of the broker (or only
  // the ones listed in billIds).
  router.post("/brokers/:id/bills/pay", auth, requireBrokerRole, (req, res) =>
    confirmPayment(req, res, null)
  );

  // POST /brokers/:id/bills/:billId/pay — pay one bill.
  router.post(
    "/brokers/:id/bills/:billId/pay",
    auth,
    requireBrokerRole,
    (req, res) => {
      const billId = parseId(req.params.billId);
      if (billId === null) {
        return res.status(400).json({ error: "Invalid bill id" });
      }
      return confirmPayment(req, res, billId);
    }
  );

  // POST /brokers/bills/close — close a period now: create the bills of every
  // broker and mail them. Body: { periodStart?, sendMail? }
  // Defaults to the period that just ended (e.g. 2026-11-16 .. 2026-11-29 while
  // the current period is 2026-11-30 .. 2026-12-13).
  router.post("/brokers/bills/close", auth, requireAdmin, async (req, res) => {
    if (!billingEnabled()) return disabled(res);
    try {
      const raw = String(req.body?.periodStart ?? "").trim();
      const periodStart = raw || lastClosedPeriod(new Date()).periodStart;
      if (!DATE_RE.test(periodStart)) {
        return res
          .status(400)
          .json({ error: "periodStart must be a YYYY-MM-DD date" });
      }
      const period = bills.periodFor(periodStart);
      const sendMail = req.body?.sendMail !== false;
      if (!sendMail) {
        const closed = await bills.closePeriod(
          DBConnection,
          period.periodStart,
          period.periodEnd
        );
        return res.json({ period, closed, mailed: null, billingEnabled: true });
      }
      const result = await closePeriodNow(DBConnection, periodStart);
      res.json({ ...result, billingEnabled: true });
    } catch (err) {
      console.error("Broker bill close failed:", err);
      res.status(500).json({ error: "Failed to close the billing period" });
    }
  });

  // POST /brokers/bills/mail-pending — retry every bill that has not reached its
  // broker yet (e.g. after an address was added).
  router.post(
    "/brokers/bills/mail-pending",
    auth,
    requireAdmin,
    async (req, res) => {
      if (!billingEnabled()) return disabled(res);
      try {
        const mailed = await sendPendingBills(DBConnection);
        res.json({ ...mailed, billingEnabled: true });
      } catch (err) {
        console.error("Broker bill mailing failed:", err);
        res.status(500).json({ error: "Failed to mail the pending bills" });
      }
    }
  );

  // Mail one stored bill to its recipient (the broker, or the main broker for a
  // sub-broker) and record the outcome on the bill. Writes the response itself.
  async function mailBillNow(res, brokerId, billId) {
    const bill = await bills.loadBill(DBConnection, brokerId, billId);
    if (!bill) {
      res.status(404).json({ error: "Bill not found" });
      return null;
    }
    const target = await bills.loadMailTarget(DBConnection, brokerId);
    if (!target) {
      res.status(404).json({ error: "Broker not found" });
      return null;
    }
    if (target.subWithoutParent) {
      const error = "sub-broker has no main broker to send the bill to";
      await bills.markBillMailFailed(DBConnection, billId, error);
      res.status(400).json({ error });
      return null;
    }
    if (target.emails.length === 0) {
      res.status(400).json({ error: "Broker has no email address" });
      return null;
    }
    const lines = await bills.loadBillDocumentLines(DBConnection, bill);
    const result = await sendBillMail({
      bill,
      brokerName: target.name,
      recipientName: target.recipientName,
      brokerCode: target.code,
      emails: target.emails,
      lines,
    });
    if (!result.sent) {
      await bills.markBillMailFailed(DBConnection, billId, result.error);
      res.status(502).json({ error: result.error });
      return null;
    }
    await bills.markBillEmailed(DBConnection, billId, { emails: target.emails });
    return {
      subject: result.subject,
      emails: target.emails,
      recipientName: target.recipientName,
      bill: await bills.loadBill(DBConnection, brokerId, billId),
    };
  }

  // POST /brokers/:id/bills/:billId/resend — mail one bill again.
  router.post(
    "/brokers/:id/bills/:billId/resend",
    auth,
    requireAdmin,
    async (req, res) => {
      if (!billingEnabled()) return disabled(res);
      try {
        const brokerId = parseId(req.params.id);
        const billId = parseId(req.params.billId);
        if (brokerId === null || billId === null) {
          return res.status(400).json({ error: "Invalid broker or bill id" });
        }
        const mailed = await mailBillNow(res, brokerId, billId);
        if (!mailed) return;
        res.json({ message: "Bill mailed", ...mailed });
      } catch (err) {
        console.error("Broker bill resend failed:", err);
        res.status(500).json({ error: "Failed to mail the bill" });
      }
    }
  );

  // PATCH /brokers/:id/bills/:billId — an admin corrects a disputed bill and it
  // is re-issued (mailed again) with the new amount.
  //
  // Body: { amount, reason?, sendMail? }
  //   amount    the corrected total (>= 0)
  //   reason    why it changed (printed on the bill and in the mail)
  //   sendMail  false = do not mail now, let the next billing run send it
  //
  // Only an unpaid bill can be adjusted: money that is already in must be
  // corrected through the balance ledger, never by rewriting a paid bill. The
  // previous amount stays in OriginalAmount, so the documents show
  // "was X, now Y".
  router.patch(
    "/brokers/:id/bills/:billId",
    auth,
    requireAdmin,
    async (req, res) => {
      if (!billingEnabled()) return disabled(res);
      try {
        const brokerId = parseId(req.params.id);
        const billId = parseId(req.params.billId);
        if (brokerId === null || billId === null) {
          return res.status(400).json({ error: "Invalid broker or bill id" });
        }
        const amount = Number(req.body?.amount);
        if (!Number.isFinite(amount) || amount < 0) {
          return res.status(400).json({ error: "amount must be a positive number" });
        }
        const bill = await bills.loadBill(DBConnection, brokerId, billId);
        if (!bill) return res.status(404).json({ error: "Bill not found" });
        if (bill.status === "paid") {
          return res.status(400).json({
            error:
              "A paid bill cannot be edited. Correct the payment in the broker's " +
              "balance history instead.",
          });
        }
        const reason = String(req.body?.reason ?? "").trim();
        const changed = await bills.adjustBill(DBConnection, billId, {
          amount: round2(amount),
          reason,
          author: (req.user && req.user.username) || "",
        });
        if (!changed) {
          return res.status(400).json({ error: "The bill could not be adjusted" });
        }

        if (req.body?.sendMail === false) {
          // Re-issue later: the next billing run picks it up.
          await bills.markBillNotMailed(DBConnection, billId);
          return res.json({
            message: "Bill adjusted",
            mailed: null,
            bill: await bills.loadBill(DBConnection, brokerId, billId),
          });
        }

        const mailed = await mailBillNow(res, brokerId, billId);
        if (!mailed) return;
        res.json({ message: "Bill adjusted and mailed", mailed, ...mailed });
      } catch (err) {
        console.error("Broker bill adjustment failed:", err);
        res.status(500).json({ error: "Failed to adjust the bill" });
      }
    }
  );

  return router;
};


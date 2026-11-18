// ------------------------------------------------------------
// Daily percentage billing — desktop port of backend/src/jobs/billingJob.js.
//
// A desktop app isn't guaranteed to be running at midnight (or at all, for
// days at a time), so this can't just check "yesterday" like the always-on
// cloud job does. Instead, on every run it backfills every missing day for
// each active daily_percentage store, oldest first, capped at 90 days per
// pass as a safety valve (a store that hasn't launched the app in over 90
// days has bigger problems than a billing backlog).
//
// Runs once on launch, then every 5 minutes, via main.js. Enforcement is
// real here (unlike the historical gap in the cloud backend that this
// project fixed) — requireNotLocked in middleware/auth.js blocks every
// store route except billing/auth once locked=1.
//
// Payment collection stays manual: a store admin clicks "I've Paid" (see
// billingController.claimPayment), which raises a notification for the
// Super Admin to confirm via markPaid. Wiring a real gateway means calling
// markPaid from that gateway's webhook instead of a person clicking a
// button — the calculation/notification/lockout logic below doesn't change.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('./db');

const MAX_BACKFILL_DAYS = 90;

function dateStringUTC(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Real POS revenue for a store on a given date (paid orders only). */
function computeTransactionTotal(storeId, dateStr) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(total), 0) AS total FROM orders
     WHERE store_id = ? AND status = 'paid' AND date(paid_at) = date(?)`
  ).get(storeId, dateStr);
  return Number(row.total) || 0;
}

function createNotification(type, storeId, billingChargeId, message) {
  db.prepare(
    `INSERT INTO notifications (id, type, store_id, billing_charge_id, message) VALUES (?,?,?,?,?)`
  ).run(crypto.randomUUID(), type, storeId, billingChargeId, message);
}

/** Ensures every fully-elapsed missing day has a charge row, for every active daily_percentage store. */
function generateDailyCharges() {
  const stores = db.prepare(
    `SELECT id, daily_rate_percent, created_at FROM stores
     WHERE billing_model = 'daily_percentage' AND subscription_status = 'active'`
  ).all();

  const today = dateStringUTC(daysAgo(0));

  for (const store of stores) {
    const latest = db.prepare(
      `SELECT MAX(charge_date) AS d FROM billing_charges WHERE store_id = ?`
    ).get(store.id);

    // First run for this store: start from the day after it activated, or
    // MAX_BACKFILL_DAYS ago, whichever is more recent.
    let cursor;
    if (latest.d) {
      cursor = new Date(latest.d + 'T00:00:00.000Z');
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else {
      const storeCreated = new Date(store.created_at);
      const cap = daysAgo(MAX_BACKFILL_DAYS);
      cursor = storeCreated > cap ? storeCreated : cap;
      cursor.setUTCHours(0, 0, 0, 0);
    }

    let generated = 0;
    while (generated < MAX_BACKFILL_DAYS) {
      const dateStr = dateStringUTC(cursor);
      if (dateStr >= today) break; // only fully-elapsed days get charged

      const total = computeTransactionTotal(store.id, dateStr);
      const amountDue = Math.round(total * (store.daily_rate_percent / 100) * 100) / 100;
      try {
        db.prepare(
          `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status)
           VALUES (?,?,?,?,?,?,?)`
        ).run(
          crypto.randomUUID(), store.id, dateStr, total, store.daily_rate_percent, amountDue,
          amountDue > 0 ? 'pending' : 'paid'
        );
      } catch (err) {
        // UNIQUE(store_id, charge_date) — a concurrent pass already wrote this row; skip.
        if (!String(err.message).includes('UNIQUE')) console.error('[billing] failed generating charge:', err.message);
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
      generated += 1;
    }
  }
}

/** Warns, then locks, stores with an unpaid charge past their grace period. */
function enforceUnpaidCharges() {
  const overdue = db.prepare(
    `SELECT bc.*, s.grace_period_minutes, s.locked, s.name AS store_name
     FROM billing_charges bc
     JOIN stores s ON s.id = bc.store_id
     WHERE bc.status = 'pending' AND bc.charge_date < date('now')`
  ).all();

  for (const charge of overdue) {
    if (charge.locked) continue; // already locked, nothing more to do

    if (!charge.warning_sent_at) {
      db.prepare(`UPDATE billing_charges SET warning_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(charge.id);
      createNotification(
        'overdue_warning', charge.store_id, charge.id,
        `${charge.store_name}: payment of ${charge.amount_due} is due for ${charge.charge_date}. The app will lock in ${charge.grace_period_minutes} minutes if unpaid.`
      );
      continue;
    }

    const graceMs = charge.grace_period_minutes * 60 * 1000;
    const dueSince = new Date(charge.warning_sent_at).getTime();
    if (Date.now() - dueSince >= graceMs) {
      db.prepare('UPDATE stores SET locked = 1 WHERE id = ?').run(charge.store_id);
      db.prepare(`UPDATE billing_charges SET status = 'overdue', locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(charge.id);
      createNotification(
        'store_locked', charge.store_id, charge.id,
        `${charge.store_name} has been locked for non-payment (${charge.amount_due} due for ${charge.charge_date}).`
      );
    }
  }
}

function runBillingCycle() {
  try {
    generateDailyCharges();
    enforceUnpaidCharges();
  } catch (err) {
    console.error('[billing] cycle failed:', err.message);
  }
}

/** Starts the periodic billing cycle (runs immediately, then every intervalMs). Returns a stop function. */
function startBillingJob(intervalMs = 5 * 60 * 1000) {
  runBillingCycle();
  const interval = setInterval(runBillingCycle, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { startBillingJob, runBillingCycle, generateDailyCharges, enforceUnpaidCharges };

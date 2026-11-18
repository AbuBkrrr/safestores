// ------------------------------------------------------------
// Daily percentage billing.
//
// For every active store on the 'daily_percentage' model, once a day has
// fully elapsed this computes that day's charge as rate_percent% of the
// store's real transaction revenue for that day (POS orders + fulfilled
// marketplace orders — the two channels that actually collect money).
// If the previous charge is still unpaid, a "5 minutes until lockout"
// warning goes out over the realtime channel, and if it's still unpaid
// grace_period_minutes later, the store is locked — every store route
// except billing status/auth starts rejecting requests (see
// requireNotLocked in middleware/auth.js) until a Super Admin marks the
// charge paid.
//
// Actually collecting the money is intentionally left as a manual "mark
// as paid" action for a Super Admin (see storesController-style
// billingController.markPaid) — wiring in a real processor (Stripe,
// Paystack, Flutterwave, etc.) means calling markPaid from that
// processor's webhook instead of a person clicking a button. The
// calculation/notification/lockout logic here doesn't change either way.
// ------------------------------------------------------------

const db = require('../config/db');
const { emitToStore } = require('../realtime');
const { captureException } = require('../utils/errorMonitoring');

async function createNotification(type, storeId, billingChargeId, message) {
  try {
    await db.query(
      `INSERT INTO notifications (type, store_id, billing_charge_id, message) VALUES ($1,$2,$3,$4)`,
      [type, storeId, billingChargeId, message]
    );
  } catch (err) {
    console.error('[billing] failed to write notification:', err.message);
  }
}

function yesterdayDateString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Real revenue for a store on a given date, across both sales channels. */
async function computeTransactionTotal(client, storeId, dateStr) {
  const posRes = await client.query(
    `SELECT COALESCE(SUM(total), 0) AS total FROM orders
     WHERE store_id = $1 AND status = 'paid' AND paid_at::date = $2::date`,
    [storeId, dateStr]
  );
  const marketRes = await client.query(
    `SELECT COALESCE(SUM(total), 0) AS total FROM marketplace_orders
     WHERE store_id = $1 AND status = 'fulfilled' AND fulfilled_at::date = $2::date`,
    [storeId, dateStr]
  );
  return Number(posRes.rows[0].total) + Number(marketRes.rows[0].total);
}

/** Ensures yesterday's charge row exists for every active daily-percentage store. */
async function generateDailyCharges() {
  const dateStr = yesterdayDateString();
  const { rows: stores } = await db.query(
    `SELECT id, daily_rate_percent FROM stores
     WHERE billing_model = 'daily_percentage' AND subscription_status = 'active'`
  );

  for (const store of stores) {
    const client = await db.pool.connect();
    try {
      const existing = await client.query(
        'SELECT id FROM billing_charges WHERE store_id = $1 AND charge_date = $2',
        [store.id, dateStr]
      );
      if (existing.rows[0]) continue; // already generated

      const total = await computeTransactionTotal(client, store.id, dateStr);
      const amountDue = Math.round(total * (store.daily_rate_percent / 100) * 100) / 100;
      await client.query(
        `INSERT INTO billing_charges (store_id, charge_date, transaction_total, rate_percent, amount_due, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [store.id, dateStr, total, store.daily_rate_percent, amountDue, amountDue > 0 ? 'pending' : 'paid']
      );
    } catch (err) {
      console.error(`[billing] failed generating charge for store ${store.id}:`, err.message);
    } finally {
      client.release();
    }
  }
}

/** Warns, then locks, stores with an unpaid charge past the grace period. */
async function enforceUnpaidCharges() {
  const { rows: overdue } = await db.query(
    `SELECT bc.*, s.grace_period_minutes, s.locked
     FROM billing_charges bc
     JOIN stores s ON s.id = bc.store_id
     WHERE bc.status = 'pending' AND bc.charge_date < CURRENT_DATE`
  );

  for (const charge of overdue) {
    if (charge.locked) continue; // already locked, nothing more to do

    if (!charge.warning_sent_at) {
      await db.query('UPDATE billing_charges SET warning_sent_at = now() WHERE id = $1', [charge.id]);
      const message = `Payment of ${charge.amount_due} is due for ${charge.charge_date}. The app will stop working in ${charge.grace_period_minutes} minutes if unpaid.`;
      emitToStore(charge.store_id, 'billing:warning', {
        message,
        amountDue: charge.amount_due,
        chargeDate: charge.charge_date,
        gracePeriodMinutes: charge.grace_period_minutes,
      });
      await createNotification('overdue_warning', charge.store_id, charge.id, message);
      continue;
    }

    const graceMs = charge.grace_period_minutes * 60 * 1000;
    const dueSince = new Date(charge.warning_sent_at).getTime();
    if (Date.now() - dueSince >= graceMs) {
      await db.query('UPDATE stores SET locked = true WHERE id = $1', [charge.store_id]);
      await db.query(`UPDATE billing_charges SET status = 'overdue', locked_at = now() WHERE id = $1`, [charge.id]);
      const message = `Store locked for non-payment (${charge.amount_due} due for ${charge.charge_date}).`;
      emitToStore(charge.store_id, 'billing:locked', {
        message: 'The app has been locked due to non-payment. Contact support to restore access.',
        chargeId: charge.id,
      });
      await createNotification('store_locked', charge.store_id, charge.id, message);
    }
  }
}

async function runBillingCycle() {
  try {
    await generateDailyCharges();
    await enforceUnpaidCharges();
  } catch (err) {
    console.error('[billing] cycle failed:', err.message);
    captureException(err, { job: 'billing' });
  }
}

/** Starts the periodic billing cycle. Returns a stop function. */
function startBillingJob(intervalMs = 60 * 1000) {
  runBillingCycle();
  const interval = setInterval(runBillingCycle, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { startBillingJob, runBillingCycle, generateDailyCharges, enforceUnpaidCharges, computeTransactionTotal };

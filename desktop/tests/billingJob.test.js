const crypto = require('crypto');
const db = require('../server/db');
const { createStore } = require('./helpers/factories');
const { generateDailyCharges, enforceUnpaidCharges } = require('../server/billingJob');

function daysAgoStr(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function backdateStoreCreatedAt(storeId, daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  db.prepare('UPDATE stores SET created_at = ? WHERE id = ?').run(d.toISOString(), storeId);
}

function insertPaidOrder(storeId, dateStr, total) {
  db.prepare(
    `INSERT INTO orders (id, store_id, status, subtotal, total, paid_at) VALUES (?,?, 'paid', ?, ?, ?)`
  ).run(crypto.randomUUID(), storeId, total, total, `${dateStr}T12:00:00.000Z`);
}

describe('billingJob: generateDailyCharges', () => {
  it('creates a pending charge for a past day with real revenue, computed from paid orders', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage', daily_rate_percent = 2.0 WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 5);
    const yesterday = daysAgoStr(1);
    insertPaidOrder(store.id, yesterday, 1000);

    generateDailyCharges();

    const charge = db.prepare('SELECT * FROM billing_charges WHERE store_id = ? AND charge_date = ?').get(store.id, yesterday);
    expect(charge).toBeTruthy();
    expect(charge.transaction_total).toBe(1000);
    expect(charge.amount_due).toBe(20); // 2% of 1000
    expect(charge.status).toBe('pending');
  });

  it('marks a zero-revenue day\'s charge as already-paid (nothing owed, no follow-up needed)', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 3);

    generateDailyCharges();

    const yesterday = daysAgoStr(1);
    const charge = db.prepare('SELECT * FROM billing_charges WHERE store_id = ? AND charge_date = ?').get(store.id, yesterday);
    expect(charge.amount_due).toBe(0);
    expect(charge.status).toBe('paid');
  });

  it('never charges today (the current, not-yet-elapsed day)', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 2);

    generateDailyCharges();

    const today = daysAgoStr(0);
    const charge = db.prepare('SELECT * FROM billing_charges WHERE store_id = ? AND charge_date = ?').get(store.id, today);
    expect(charge).toBeUndefined();
  });

  it('backfills every missing day since the store was created (not just yesterday)', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 4);

    generateDailyCharges();

    const charges = db.prepare('SELECT charge_date FROM billing_charges WHERE store_id = ? ORDER BY charge_date').all(store.id);
    expect(charges).toHaveLength(4); // days -4, -3, -2, -1 (not day 0, today)
  });

  it('a second run does not double-charge already-billed days', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 3);

    generateDailyCharges();
    generateDailyCharges(); // simulate the 5-minute interval firing again

    const charges = db.prepare('SELECT * FROM billing_charges WHERE store_id = ?').all(store.id);
    expect(charges).toHaveLength(3); // still just once per day, not doubled
  });

  it('ignores stores on the custom billing model entirely', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'custom' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 3);

    generateDailyCharges();

    const charges = db.prepare('SELECT * FROM billing_charges WHERE store_id = ?').all(store.id);
    expect(charges).toHaveLength(0);
  });

  it('caps backfill at 90 days for a store that hasn\'t run the app in a very long time', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET billing_model = 'daily_percentage' WHERE id = ?`).run(store.id);
    backdateStoreCreatedAt(store.id, 500); // way beyond the 90-day cap

    generateDailyCharges();

    const charges = db.prepare('SELECT * FROM billing_charges WHERE store_id = ?').all(store.id);
    expect(charges.length).toBeLessThanOrEqual(90);
  });
});

describe('billingJob: enforceUnpaidCharges', () => {
  it('sends a warning notification on first pass, does not lock immediately', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET grace_period_minutes = 5 WHERE id = ?`).run(store.id);
    const yesterday = daysAgoStr(1);
    db.prepare(
      `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status)
       VALUES (?,?,?,1000,2,20,'pending')`
    ).run(crypto.randomUUID(), store.id, yesterday);

    enforceUnpaidCharges();

    const store2 = db.prepare('SELECT locked FROM stores WHERE id = ?').get(store.id);
    expect(!!store2.locked).toBe(false);
    const notif = db.prepare(`SELECT * FROM notifications WHERE store_id = ? AND type = 'overdue_warning'`).get(store.id);
    expect(notif).toBeTruthy();
  });

  it('locks the store once the grace period has elapsed since the warning', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    db.prepare(`UPDATE stores SET grace_period_minutes = 5 WHERE id = ?`).run(store.id);
    const yesterday = daysAgoStr(1);
    const chargeId = crypto.randomUUID();
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago > 5 min grace
    db.prepare(
      `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status, warning_sent_at)
       VALUES (?,?,?,1000,2,20,'pending',?)`
    ).run(chargeId, store.id, yesterday, longAgo);

    enforceUnpaidCharges();

    const storeRow = db.prepare('SELECT locked FROM stores WHERE id = ?').get(store.id);
    expect(!!storeRow.locked).toBe(true);
    const charge = db.prepare('SELECT status FROM billing_charges WHERE id = ?').get(chargeId);
    expect(charge.status).toBe('overdue');
    const notif = db.prepare(`SELECT * FROM notifications WHERE store_id = ? AND type = 'store_locked'`).get(store.id);
    expect(notif).toBeTruthy();
  });

  it('does not re-lock or re-notify a store that is already locked', async () => {
    const store = await createStore({ subscriptionStatus: 'active', locked: true });
    const yesterday = daysAgoStr(1);
    db.prepare(
      `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status, warning_sent_at)
       VALUES (?,?,?,1000,2,20,'pending', datetime('now','-1 hour'))`
    ).run(crypto.randomUUID(), store.id, yesterday);

    enforceUnpaidCharges();

    const notifs = db.prepare(`SELECT * FROM notifications WHERE store_id = ?`).all(store.id);
    expect(notifs).toHaveLength(0);
  });

  it('a paid charge is never warned or locked', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    const yesterday = daysAgoStr(1);
    db.prepare(
      `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status)
       VALUES (?,?,?,1000,2,20,'paid')`
    ).run(crypto.randomUUID(), store.id, yesterday);

    enforceUnpaidCharges();

    const storeRow = db.prepare('SELECT locked FROM stores WHERE id = ?').get(store.id);
    expect(!!storeRow.locked).toBe(false);
  });
});

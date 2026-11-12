// ------------------------------------------------------------
// Bolt-style settlement between the platform and each store, for orders
// that come through the app (storefront / marketplace). See
// migrations/037_store_settlements.sql for the model in plain words.
//
// Balance = SUM(store_ledger.amount); positive means the store owes the
// platform. Only the platform's commission ever flows to the platform —
// shopper money goes from Paystack straight to the store (online) or is
// collected by the store itself (cash).
// ------------------------------------------------------------
const crypto = require('crypto');
const db = require('../config/db');
const paystack = require('../utils/paystack');
const { r2 } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}

/** Commission %, debt limit and recovery cap that apply to a store. */
async function terms(client, storeId) {
  const { rows } = await client.query(
    `SELECT COALESCE(s.commission_pct, p.marketplace_commission_pct, 0) AS commission_pct,
            COALESCE(p.cash_debt_limit, 0) AS cash_debt_limit, COALESCE(p.max_recovery_pct, 50) AS max_recovery_pct,
            s.commission_pct IS NOT NULL AS custom_commission
     FROM stores s LEFT JOIN payment_settings p ON p.id = 'default' WHERE s.id = $1`,
    [storeId]
  );
  const t = rows[0] || {};
  return {
    commissionPct: Number(t.commission_pct || 0), cashDebtLimit: Number(t.cash_debt_limit || 0),
    maxRecoveryPct: Number(t.max_recovery_pct ?? 50), customCommission: !!t.custom_commission,
  };
}

async function balance(client, storeId) {
  const { rows } = await client.query('SELECT COALESCE(SUM(amount), 0) AS b FROM store_ledger WHERE store_id = $1', [storeId]);
  return r2(rows[0].b);
}

/** Debt already earmarked for recovery by online payments still in progress. */
async function reservedRecovery(client, storeId, exceptOrderId = null) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(debt_recovery), 0) AS r FROM marketplace_orders
     WHERE store_id = $1 AND payment_status = 'pending' AND ($2::uuid IS NULL OR id <> $2)`,
    [storeId, exceptOrderId]
  );
  return r2(rows[0].r);
}

/** Over the limit → no more pay-on-delivery until settled. 0 = no limit. */
async function cashBlocked(client, storeId) {
  const t = await terms(client, storeId);
  if (!(t.cashDebtLimit > 0)) return false;
  return (await balance(client, storeId)) > t.cashDebtLimit;
}

/**
 * How an online payment for `order` is split: the platform's commission,
 * plus a capped slice of whatever the store owes (netting). Everything else
 * settles to the store.
 */
async function planOnlineSplit(client, order) {
  const t = await terms(client, order.store_id);
  const total = Number(order.total);
  const commission = r2(total * t.commissionPct / 100);
  const owed = Math.max(0, r2((await balance(client, order.store_id)) - (await reservedRecovery(client, order.store_id, order.id))));
  const cap = r2(Math.max(0, total - commission) * t.maxRecoveryPct / 100);
  const recovery = r2(Math.min(owed, cap));
  return { commissionPct: t.commissionPct, commission, recovery, storeReceives: r2(total - commission - recovery) };
}

/** Ledger entries once an online payment is confirmed. Idempotent (unique per order+type). */
async function recordOnlinePaid(client, order) {
  await client.query(
    `INSERT INTO store_ledger (store_id, type, amount, order_total, commission, marketplace_order_id, reference, note)
     VALUES ($1,'online_commission',0,$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING`,
    [order.store_id, order.total, order.commission_amount || 0, order.id, order.payment_reference]
  );
  if (Number(order.debt_recovery) > 0) {
    await client.query(
      `INSERT INTO store_ledger (store_id, type, amount, order_total, marketplace_order_id, reference, note)
       VALUES ($1,'debt_recovered',$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING`,
      [order.store_id, -Number(order.debt_recovery), order.total, order.id, order.payment_reference]
    );
  }
}

/** A pay-on-delivery order was completed: the store collected the money and now owes the commission. */
async function recordCashCompleted(client, order, userId) {
  if (order.payment_method !== 'on_delivery' || order.payment_status === 'paid') return;
  const t = await terms(client, order.store_id);
  const pct = order.commission_pct != null ? Number(order.commission_pct) : t.commissionPct;
  const commission = r2(Number(order.total) * pct / 100);
  await client.query(
    `UPDATE marketplace_orders SET payment_status = 'paid', paid_at = now(), amount_paid = total, commission_pct = $1, commission_amount = $2 WHERE id = $3`,
    [pct, commission, order.id]
  );
  if (commission > 0) {
    await client.query(
      `INSERT INTO store_ledger (store_id, type, amount, order_total, commission, marketplace_order_id, note, created_by)
       VALUES ($1,'cash_commission',$2,$3,$2,$4,NULL,$5) ON CONFLICT DO NOTHING`,
      [order.store_id, commission, order.total, order.id, userId || null]
    );
  }
}

// ---------------- store side ----------------

async function statement(storeId, { limit = 100, before = null } = {}) {
  const t = await terms(db, storeId);
  const bal = await balance(db, storeId);
  const { rows: entries } = await db.query(
    `SELECT l.*, mo.tracking_token FROM store_ledger l LEFT JOIN marketplace_orders mo ON mo.id = l.marketplace_order_id
     WHERE l.store_id = $1 AND ($2::timestamptz IS NULL OR l.created_at < $2) ORDER BY l.created_at DESC LIMIT $3`,
    [storeId, before, limit]
  );
  const { rows: month } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('cash_commission','online_commission') THEN order_total END), 0) AS app_sales,
            COALESCE(SUM(CASE WHEN type IN ('cash_commission','online_commission') THEN commission END), 0) AS commissions,
            COALESCE(SUM(CASE WHEN type = 'cash_commission' THEN order_total END), 0) AS cash_sales,
            COALESCE(SUM(CASE WHEN type = 'online_commission' THEN order_total END), 0) AS online_sales
     FROM store_ledger WHERE store_id = $1 AND created_at >= date_trunc('month', now())`,
    [storeId]
  );
  const m = month[0];
  return {
    balance: bal, owes: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0,
    terms: t,
    cashBlocked: t.cashDebtLimit > 0 && bal > t.cashDebtLimit,
    thisMonth: { appSales: r2(m.app_sales), cashSales: r2(m.cash_sales), onlineSales: r2(m.online_sales), commissions: r2(m.commissions) },
    canPayOnline: paystack.isConfigured,
    entries: entries.map((e) => ({ ...e, amount: Number(e.amount), order_total: e.order_total == null ? null : Number(e.order_total), commission: e.commission == null ? null : Number(e.commission) })),
  };
}

// GET /api/stores/:storeId/settlements
async function getStatement(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json(await statement(req.params.storeId, { limit, before: req.query.before || null }));
}

// POST /api/stores/:storeId/settlements/pay { amount? } — pay the balance to the platform via Paystack.
async function startSettlementPayment(req, res) {
  const { storeId } = req.params;
  if (!paystack.isConfigured) return res.status(503).json({ error: 'Online payment is not set up yet — pay by bank transfer and the platform will record it.' });
  const owed = await balance(db, storeId);
  if (!(owed > 0)) return res.status(400).json({ error: 'Nothing to pay — your balance is clear.' });
  const amount = req.body?.amount ? r2(Math.min(Number(req.body.amount), owed)) : owed;
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount to pay' });
  const { rows: u } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
  const { rows: c } = await db.query(
    `SELECT COALESCE(s.currency_code, c.code) AS code FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = $1`, [storeId]
  );
  const reference = `SET-${storeId.slice(0, 8)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
  let init;
  try {
    init = await paystack.initializeTransaction({
      email: u[0]?.email, amountNaira: amount, reference, callbackUrl: `${frontendBase()}/settlements`,
      metadata: { kind: 'store_settlement', store_id: storeId },
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not start the payment: ${err.message}` });
  }
  await db.query(
    'INSERT INTO store_settlement_payments (reference, store_id, amount, currency, created_by) VALUES ($1,$2,$3,$4,$5)',
    [reference, storeId, amount, c[0]?.code || null, req.user.sub]
  );
  res.json({ authorizationUrl: init.authorizationUrl, reference });
}

/** Confirms a settlement payment with Paystack and credits the store. Idempotent. */
async function confirmSettlementPayment(reference) {
  const { rows } = await db.query('SELECT * FROM store_settlement_payments WHERE reference = $1', [reference]);
  const p = rows[0];
  if (!p) return { ok: false, reason: 'unknown_reference' };
  if (p.status === 'paid') return { ok: true };
  const v = await paystack.verifyTransaction(reference);
  if (!v.success) return { ok: false, reason: 'not_successful' };
  if (Math.round(Number(v.amountNaira) * 100) !== Math.round(Number(p.amount) * 100)) return { ok: false, reason: 'amount_mismatch' };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE store_settlement_payments SET status = 'paid', paid_at = now() WHERE reference = $1 AND status <> 'paid'`, [reference]
    );
    if (rowCount) {
      await client.query(
        `INSERT INTO store_ledger (store_id, type, amount, reference, note, created_by)
         VALUES ($1,'settlement_payment',$2,$3,'Paid online',$4) ON CONFLICT DO NOTHING`,
        [p.store_id, -Number(p.amount), reference, p.created_by]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true };
}

// POST /api/stores/:storeId/settlements/verify { reference }
async function verifySettlementPayment(req, res) {
  const { rows } = await db.query('SELECT store_id FROM store_settlement_payments WHERE reference = $1', [req.body?.reference]);
  if (!rows[0] || rows[0].store_id !== req.params.storeId) return res.status(404).json({ error: 'Payment not found' });
  try {
    const r = await confirmSettlementPayment(req.body.reference);
    return res.json({ paid: r.ok, reason: r.ok ? undefined : r.reason });
  } catch {
    return res.status(502).json({ error: 'Could not reach the payment provider. Please refresh in a moment.' });
  }
}

// ---------------- super admin ----------------

// GET /api/super/settlements — every store with app-order activity, biggest balance first.
async function listBalances(req, res) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.city, s.commission_pct, COALESCE(SUM(l.amount), 0) AS balance, MAX(l.created_at) AS last_activity,
            COALESCE(SUM(CASE WHEN l.type IN ('cash_commission','online_commission') THEN l.commission END), 0) AS commissions_total
     FROM stores s JOIN store_ledger l ON l.store_id = s.id
     GROUP BY s.id ORDER BY balance DESC`
  );
  const { rows: p } = await db.query(`SELECT marketplace_commission_pct, cash_debt_limit, max_recovery_pct FROM payment_settings WHERE id = 'default'`);
  const settings = p[0] || {};
  res.json({
    settings: { marketplaceCommissionPct: Number(settings.marketplace_commission_pct || 0), cashDebtLimit: Number(settings.cash_debt_limit || 0), maxRecoveryPct: Number(settings.max_recovery_pct ?? 50) },
    stores: rows.map((r) => ({ ...r, balance: r2(r.balance), commissions_total: r2(r.commissions_total), commission_pct: r.commission_pct == null ? null : Number(r.commission_pct) })),
    totalOwed: r2(rows.reduce((s, r) => s + Math.max(0, Number(r.balance)), 0)),
  });
}

// GET /api/super/settlements/:storeId
async function storeStatementForSuper(req, res) {
  res.json(await statement(req.params.storeId, { limit: 300 }));
}

// PATCH /api/super/settlement-settings { marketplaceCommissionPct?, cashDebtLimit?, maxRecoveryPct? }
async function updateSettings(req, res) {
  const { marketplaceCommissionPct, cashDebtLimit, maxRecoveryPct } = req.body || {};
  const sets = []; const vals = [];
  const add = (col, v, min, max) => {
    if (v === undefined) return null;
    const n = Number(v);
    if (!(n >= min && n <= max)) return `${col} must be between ${min} and ${max}`;
    vals.push(n); sets.push(`${col} = $${vals.length}`); return null;
  };
  const err = add('marketplace_commission_pct', marketplaceCommissionPct, 0, 50) || add('cash_debt_limit', cashDebtLimit, 0, 1e12) || add('max_recovery_pct', maxRecoveryPct, 0, 90);
  if (err) return res.status(400).json({ error: err });
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  await db.query(`UPDATE payment_settings SET ${sets.join(', ')} WHERE id = 'default'`, vals);
  logActivity(req, { storeId: null, action: 'platform.settlement_settings_changed', details: req.body });
  return listBalances(req, res);
}

// PATCH /api/super/stores/:storeId/commission { commissionPct: number|null }
async function setStoreCommission(req, res) {
  const v = req.body?.commissionPct;
  if (v !== null && !(Number(v) >= 0 && Number(v) <= 50)) return res.status(400).json({ error: 'Commission must be between 0 and 50, or empty for the platform default' });
  const { rowCount } = await db.query('UPDATE stores SET commission_pct = $1 WHERE id = $2', [v === null ? null : Number(v), req.params.storeId]);
  if (!rowCount) return res.status(404).json({ error: 'Store not found' });
  logActivity(req, { storeId: req.params.storeId, action: 'store.commission_changed', details: { commissionPct: v } });
  res.json(await terms(db, req.params.storeId));
}

// POST /api/super/settlements/:storeId/entries { type: 'settlement_payment'|'adjustment', amount, reference?, note }
// A bank transfer received from the store (reduces what it owes), or a correction.
async function recordEntry(req, res) {
  const { storeId } = req.params;
  const { type, reference = null, note = null } = req.body || {};
  const amount = r2(req.body?.amount);
  if (!['settlement_payment', 'adjustment'].includes(type)) return res.status(400).json({ error: 'type must be settlement_payment or adjustment' });
  if (!amount || (type === 'settlement_payment' && amount <= 0)) return res.status(400).json({ error: 'Enter a valid amount' });
  if (type === 'adjustment' && !note) return res.status(400).json({ error: 'Explain the adjustment in the note' });
  const { rows: s } = await db.query('SELECT id FROM stores WHERE id = $1', [storeId]);
  if (!s[0]) return res.status(404).json({ error: 'Store not found' });
  try {
    await db.query(
      `INSERT INTO store_ledger (store_id, type, amount, reference, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [storeId, type, type === 'settlement_payment' ? -amount : amount, reference, note || (type === 'settlement_payment' ? 'Bank transfer received' : null), req.user.sub]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That payment reference was already recorded' });
    throw err;
  }
  logActivity(req, { storeId, action: `settlement.${type}`, details: { amount, reference, note } });
  res.status(201).json(await statement(storeId, { limit: 50 }));
}

module.exports = {
  terms, balance, cashBlocked, planOnlineSplit, recordOnlinePaid, recordCashCompleted,
  getStatement, startSettlementPayment, confirmSettlementPayment, verifySettlementPayment,
  listBalances, storeStatementForSuper, updateSettings, setStoreCommission, recordEntry,
};

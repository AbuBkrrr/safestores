// Desktop twin of backend/src/controllers/shiftsController.js +
// storeSettingsController.js (shifts, Z-report, daily report, store settings).
const crypto = require('crypto');
const db = require('../db');
const { r2 } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');
const { localDate, localHour, todayIn, utcWindowFor, isValidTimezone, symbolFor } = require('../utils/tz');

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MANAGERS = ['admin', 'manager'];

function cashFigures(shiftId) {
  const payments = db.prepare(
    'SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT order_id) AS orders FROM order_payments WHERE shift_id = ? GROUP BY method'
  ).all(shiftId);
  const refunds = db.prepare('SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM refunds WHERE shift_id = ? GROUP BY method').all(shiftId);
  const cashIn = Number(payments.find((p) => p.method === 'cash')?.total || 0);
  const cashOut = Number(refunds.find((p) => p.method === 'cash')?.total || 0);
  return { payments, refunds, cashIn, cashOut };
}

function currentShift(req, res) {
  const s = db.prepare(`SELECT * FROM shifts WHERE store_id = ? AND opened_by = ? AND status = 'open'`).get(req.params.storeId, req.user.sub);
  if (!s) return res.json(null);
  const f = cashFigures(s.id);
  res.json({ ...s, expected_cash_now: r2(Number(s.opening_float) + f.cashIn - f.cashOut) });
}

function openShift(req, res) {
  const { storeId } = req.params;
  const float = Number(req.body?.openingFloat) || 0;
  if (float < 0) return res.status(400).json({ error: 'Opening float cannot be negative' });
  const existing = db.prepare(`SELECT * FROM shifts WHERE store_id = ? AND opened_by = ? AND status = 'open'`).get(storeId, req.user.sub);
  if (existing) return res.status(200).json(existing);
  const id = req.body?.id || crypto.randomUUID();
  db.prepare('INSERT INTO shifts (id, store_id, opened_by, opening_float) VALUES (?,?,?,?)').run(id, storeId, req.user.sub, float);
  db.prepare(`UPDATE orders SET shift_id = ? WHERE store_id = ? AND created_by = ? AND status = 'pending_payment' AND shift_id IS NULL`).run(id, storeId, req.user.sub);
  logActivity(req, { storeId, action: 'shift.opened', entityType: 'shift', entityId: id, details: { openingFloat: float } });
  res.status(201).json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(id));
}

function closeShift(req, res) {
  const { storeId, shiftId } = req.params;
  const counted = Number(req.body?.countedCash);
  if (!(counted >= 0)) return res.status(400).json({ error: 'Enter the cash you counted in the drawer' });
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND store_id = ?').get(shiftId, storeId);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (shift.status !== 'open') return res.status(400).json({ error: 'This shift is already closed' });
  if (shift.opened_by !== req.user.sub && !MANAGERS.includes(req.user.role)) return res.status(403).json({ error: 'Only the cashier or a manager can close this shift' });
  const f = cashFigures(shiftId);
  const expected = r2(Number(shift.opening_float) + f.cashIn - f.cashOut);
  db.prepare(`UPDATE shifts SET status = 'closed', closed_by = ?, closed_at = ${NOW}, expected_cash = ?, counted_cash = ?, notes = ? WHERE id = ?`)
    .run(req.user.sub, expected, counted, req.body?.notes ? String(req.body.notes).slice(0, 500) : null, shiftId);
  logActivity(req, { storeId, action: 'shift.closed', entityType: 'shift', entityId: shiftId, details: { expected, counted, variance: r2(counted - expected) } });
  res.json({ ...db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId), variance: r2(counted - expected) });
}

function listShifts(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const mineOnly = !MANAGERS.includes(req.user.role);
  const rows = db.prepare(
    `SELECT sh.*, u1.name AS opened_by_name, u2.name AS closed_by_name, (sh.counted_cash - sh.expected_cash) AS variance
     FROM shifts sh LEFT JOIN users u1 ON u1.id = sh.opened_by LEFT JOIN users u2 ON u2.id = sh.closed_by
     WHERE sh.store_id = ? ${mineOnly ? 'AND sh.opened_by = ?' : ''} ORDER BY sh.opened_at DESC LIMIT ?`
  ).all(...(mineOnly ? [req.params.storeId, req.user.sub, limit] : [req.params.storeId, limit]));
  res.json(rows);
}

function shiftReport(req, res) {
  const { storeId, shiftId } = req.params;
  const shift = db.prepare(
    `SELECT sh.*, u1.name AS opened_by_name, u2.name AS closed_by_name FROM shifts sh
     LEFT JOIN users u1 ON u1.id = sh.opened_by LEFT JOIN users u2 ON u2.id = sh.closed_by WHERE sh.id = ? AND sh.store_id = ?`
  ).get(shiftId, storeId);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (shift.opened_by !== req.user.sub && !MANAGERS.includes(req.user.role)) return res.status(403).json({ error: 'You can only view your own shift reports' });
  const f = cashFigures(shiftId);
  const sales = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(discount_amount), 0) AS discounts, COALESCE(SUM(tax_amount), 0) AS tax
     FROM orders WHERE shift_id = ? AND status = 'paid'`
  ).get(shiftId);
  const units = db.prepare(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.shift_id = ? AND o.status = 'paid'`
  ).get(shiftId).units;
  const refundsTotal = r2(f.refunds.reduce((a, r) => a + Number(r.total), 0));
  const expected = shift.status === 'closed' ? Number(shift.expected_cash) : r2(Number(shift.opening_float) + f.cashIn - f.cashOut);
  res.json({
    shift,
    sales: { count: sales.count, gross: r2(sales.gross), discounts: r2(sales.discounts), tax: r2(sales.tax), units },
    payments: f.payments.map((p) => ({ method: p.method, total: r2(p.total), orders: p.orders })),
    refunds: { total: refundsTotal, byMethod: f.refunds.map((r) => ({ method: r.method, total: r2(r.total), count: r.count })) },
    net: r2(sales.gross - refundsTotal),
    cash: {
      openingFloat: Number(shift.opening_float), cashSales: r2(f.cashIn), cashRefunds: r2(f.cashOut), expected,
      counted: shift.counted_cash == null ? null : Number(shift.counted_cash),
      variance: shift.counted_cash == null ? null : r2(Number(shift.counted_cash) - expected),
    },
  });
}

function dailyReport(req, res) {
  const { storeId } = req.params;
  const tz = db.prepare('SELECT timezone FROM stores WHERE id = ?').get(storeId)?.timezone || 'UTC';
  const day = req.query.date || todayIn(tz);
  const [from, to] = utcWindowFor(day);
  const inDay = (iso) => iso && localDate(iso, tz) === day;
  const orders = db.prepare(`SELECT * FROM orders WHERE store_id = ? AND status = 'paid' AND paid_at BETWEEN ? AND ?`).all(storeId, from, to).filter((o) => inDay(o.paid_at));
  const ids = new Set(orders.map((o) => o.id));
  const refunds = db.prepare('SELECT * FROM refunds WHERE store_id = ? AND created_at BETWEEN ? AND ?').all(storeId, from, to).filter((r) => inDay(r.created_at));
  const payments = db.prepare(
    `SELECT op.* FROM order_payments op JOIN orders o ON o.id = op.order_id WHERE o.store_id = ? AND o.paid_at BETWEEN ? AND ?`
  ).all(storeId, from, to).filter((p) => ids.has(p.order_id));
  const items = db.prepare(
    `SELECT oi.order_id, oi.quantity, oi.line_total, p.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.store_id = ? AND o.status = 'paid' AND o.paid_at BETWEEN ? AND ?`
  ).all(storeId, from, to).filter((i) => ids.has(i.order_id));
  const users = Object.fromEntries(db.prepare('SELECT id, name FROM users WHERE store_id = ?').all(storeId).map((u) => [u.id, u.name]));

  const sum = (arr, k) => r2(arr.reduce((a, x) => a + Number(x[k] || 0), 0));
  const group = (arr, keyFn, valFn) => {
    const m = new Map();
    for (const x of arr) { const k = keyFn(x); const v = m.get(k) || { key: k, count: 0, total: 0, units: 0 }; v.count += 1; v.total = r2(v.total + Number(valFn(x) || 0)); v.units += Number(x.quantity || 0); m.set(k, v); }
    return [...m.values()];
  };
  const gross = sum(orders, 'total');
  const refundTotal = sum(refunds, 'amount');
  res.json({
    date: day, timezone: tz, orders: orders.length, gross, discounts: sum(orders, 'discount_amount'), tax: sum(orders, 'tax_amount'),
    average: orders.length ? r2(gross / orders.length) : 0,
    refunds: { total: refundTotal, count: refunds.length }, net: r2(gross - refundTotal),
    byMethod: group(payments, (p) => p.method, (p) => p.amount).map((g) => ({ method: g.key, total: g.total })).sort((a, b) => b.total - a.total),
    byHour: group(orders, (o) => localHour(o.paid_at, tz), (o) => o.total).map((g) => ({ hour: g.key, orders: g.count, total: g.total })).sort((a, b) => a.hour - b.hour),
    byCashier: group(orders, (o) => users[o.paid_by] || '—', (o) => o.total).map((g) => ({ name: g.key, orders: g.count, total: g.total })).sort((a, b) => b.total - a.total),
    topItems: group(items, (i) => i.name, (i) => i.line_total).map((g) => ({ name: g.key, units: g.units, total: g.total })).sort((a, b) => b.units - a.units).slice(0, 10),
  });
}

// ---------------- store settings ----------------
const FIELDS = {
  currencyCode: 'currency_code', currencySymbol: 'currency_symbol', timezone: 'timezone',
  taxRatePct: 'tax_rate_pct', taxInclusive: 'tax_inclusive', taxLabel: 'tax_label', taxNumber: 'tax_number',
  phone: 'phone', address: 'address', city: 'city', receiptHeader: 'receipt_header', receiptFooter: 'receipt_footer',
  maxCashierDiscountPct: 'max_cashier_discount_pct', requireShift: 'require_shift', name: 'name',
};

function readSettings(storeId) {
  const r = db.prepare(
    `SELECT s.id, s.name, s.timezone, s.tax_rate_pct, s.tax_inclusive, s.tax_label, s.tax_number, s.phone, s.address, s.city,
            s.receipt_header, s.receipt_footer, s.max_cashier_discount_pct, s.require_shift,
            s.currency_code AS store_currency_code, s.currency_symbol AS store_currency_symbol,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = ?`
  ).get(storeId);
  if (!r) return null;
  return { ...r, tax_inclusive: !!r.tax_inclusive, require_shift: !!r.require_shift };
}

function getSettings(req, res) {
  const s = readSettings(req.params.storeId);
  if (!s) return res.status(404).json({ error: 'Store not found' });
  res.json(s);
}

function updateSettings(req, res) {
  const { storeId } = req.params;
  const body = { ...(req.body || {}) };
  if (body.currencyCode !== undefined) {
    if (!body.currencyCode) { body.currencyCode = null; body.currencySymbol = null; } else {
      const code = String(body.currencyCode).toUpperCase();
      if (!/^[A-Z]{3}$/.test(code) || !symbolFor(code)) return res.status(400).json({ error: 'Unknown currency code' });
      body.currencyCode = code;
      if (!body.currencySymbol) body.currencySymbol = symbolFor(code);
    }
  }
  if (body.timezone !== undefined && !isValidTimezone(body.timezone)) return res.status(400).json({ error: 'Unknown time zone' });
  for (const k of ['taxRatePct', 'maxCashierDiscountPct']) {
    if (body[k] !== undefined) {
      const r = Number(body[k]);
      if (!(r >= 0 && r <= 100)) return res.status(400).json({ error: 'Percentages must be between 0 and 100' });
      body[k] = r;
    }
  }
  if (body.name !== undefined && !String(body.name).trim()) return res.status(400).json({ error: 'Store name cannot be empty' });
  const sets = []; const values = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (['taxInclusive', 'requireShift'].includes(k)) v = v ? 1 : 0;
    else if (typeof v === 'string') v = v.trim().slice(0, k.startsWith('receipt') ? 500 : 160) || null;
    sets.push(`${col} = ?`); values.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE stores SET ${sets.join(', ')} WHERE id = ?`).run(...values, storeId);
  logActivity(req, { storeId, action: 'store.settings_changed', entityType: 'store', entityId: storeId, details: { fields: Object.keys(body) } });
  res.json(readSettings(storeId));
}

module.exports = { currentShift, openShift, closeShift, listShifts, shiftReport, dailyReport, getSettings, updateSettings };

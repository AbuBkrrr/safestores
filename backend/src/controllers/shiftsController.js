// ------------------------------------------------------------
// Cashier shifts + end-of-day reporting.
//
// A shift is one person's stint on a till: it opens with a cash float and
// closes with a counted-cash figure. Expected cash = float + cash taken −
// cash refunded; the difference is the drawer's over/short. The Z-report
// summarises a shift; the daily report summarises a calendar day in the
// store's own time zone.
// ------------------------------------------------------------
const db = require('../config/db');
const { r2 } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');

async function shiftCashFigures(shiftId) {
  const { rows: pay } = await db.query(
    `SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT order_id)::int AS orders
     FROM order_payments WHERE shift_id = $1 GROUP BY method`,
    [shiftId]
  );
  const { rows: ref } = await db.query(
    `SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count FROM refunds WHERE shift_id = $1 GROUP BY method`,
    [shiftId]
  );
  const cashIn = Number(pay.find((p) => p.method === 'cash')?.total || 0);
  const cashOut = Number(ref.find((p) => p.method === 'cash')?.total || 0);
  return { payments: pay, refunds: ref, cashIn, cashOut };
}

// GET /api/stores/:storeId/shifts/current
async function currentShift(req, res) {
  const { rows } = await db.query(
    `SELECT * FROM shifts WHERE store_id = $1 AND opened_by = $2 AND status = 'open'`,
    [req.params.storeId, req.user.sub]
  );
  if (!rows[0]) return res.json(null);
  const f = await shiftCashFigures(rows[0].id);
  res.json({ ...rows[0], expected_cash_now: r2(Number(rows[0].opening_float) + f.cashIn - f.cashOut) });
}

// POST /api/stores/:storeId/shifts  { openingFloat, id? }
async function openShift(req, res) {
  const { storeId } = req.params;
  const float = Number(req.body?.openingFloat) || 0;
  if (float < 0) return res.status(400).json({ error: 'Opening float cannot be negative' });
  const { rows: existing } = await db.query(
    `SELECT * FROM shifts WHERE store_id = $1 AND opened_by = $2 AND status = 'open'`, [storeId, req.user.sub]
  );
  if (existing[0]) return res.status(200).json(existing[0]); // idempotent — already open
  const { rows } = await db.query(
    `INSERT INTO shifts (${req.body?.id ? 'id, ' : ''}store_id, opened_by, opening_float)
     VALUES (${req.body?.id ? '$4, ' : ''}$1, $2, $3) RETURNING *`,
    req.body?.id ? [storeId, req.user.sub, float, req.body.id] : [storeId, req.user.sub, float]
  );
  // Sales already rung up on an order this person opened before the shift
  // started still belong to it once paid — attach any of their pending ones.
  await db.query(
    `UPDATE orders SET shift_id = $1 WHERE store_id = $2 AND created_by = $3 AND status = 'pending_payment' AND shift_id IS NULL`,
    [rows[0].id, storeId, req.user.sub]
  );
  logActivity(req, { storeId, action: 'shift.opened', entityType: 'shift', entityId: rows[0].id, details: { openingFloat: float } });
  res.status(201).json(rows[0]);
}

// POST /api/stores/:storeId/shifts/:shiftId/close  { countedCash, notes }
async function closeShift(req, res) {
  const { storeId, shiftId } = req.params;
  const counted = Number(req.body?.countedCash);
  if (!(counted >= 0)) return res.status(400).json({ error: 'Enter the cash you counted in the drawer' });
  const { rows: s } = await db.query('SELECT * FROM shifts WHERE id = $1 AND store_id = $2', [shiftId, storeId]);
  const shift = s[0];
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (shift.status !== 'open') return res.status(400).json({ error: 'This shift is already closed' });
  const isOwner = shift.opened_by === req.user.sub;
  if (!isOwner && !['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ error: 'Only the cashier or a manager can close this shift' });

  const f = await shiftCashFigures(shiftId);
  const expected = r2(Number(shift.opening_float) + f.cashIn - f.cashOut);
  const { rows } = await db.query(
    `UPDATE shifts SET status = 'closed', closed_by = $1, closed_at = now(), expected_cash = $2, counted_cash = $3, notes = $4
     WHERE id = $5 RETURNING *`,
    [req.user.sub, expected, counted, req.body?.notes ? String(req.body.notes).slice(0, 500) : null, shiftId]
  );
  logActivity(req, { storeId, action: 'shift.closed', entityType: 'shift', entityId: shiftId, details: { expected, counted, variance: r2(counted - expected) } });
  res.json({ ...rows[0], variance: r2(counted - expected) });
}

// GET /api/stores/:storeId/shifts?limit=
async function listShifts(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const mineOnly = !['admin', 'manager'].includes(req.user.role);
  const { rows } = await db.query(
    `SELECT sh.*, u1.name AS opened_by_name, u2.name AS closed_by_name,
            (sh.counted_cash - sh.expected_cash) AS variance
     FROM shifts sh LEFT JOIN users u1 ON u1.id = sh.opened_by LEFT JOIN users u2 ON u2.id = sh.closed_by
     WHERE sh.store_id = $1 ${mineOnly ? 'AND sh.opened_by = $3' : ''}
     ORDER BY sh.opened_at DESC LIMIT $2`,
    mineOnly ? [req.params.storeId, limit, req.user.sub] : [req.params.storeId, limit]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/shifts/:shiftId/report  — the Z-report
async function shiftReport(req, res) {
  const { storeId, shiftId } = req.params;
  const { rows: s } = await db.query(
    `SELECT sh.*, u1.name AS opened_by_name, u2.name AS closed_by_name FROM shifts sh
     LEFT JOIN users u1 ON u1.id = sh.opened_by LEFT JOIN users u2 ON u2.id = sh.closed_by
     WHERE sh.id = $1 AND sh.store_id = $2`,
    [shiftId, storeId]
  );
  const shift = s[0];
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (shift.opened_by !== req.user.sub && !['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'You can only view your own shift reports' });
  }
  const f = await shiftCashFigures(shiftId);
  const { rows: sales } = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(discount_amount), 0) AS discounts,
            COALESCE(SUM(tax_amount), 0) AS tax
     FROM orders WHERE shift_id = $1 AND status = 'paid'`,
    [shiftId]
  );
  const { rows: items } = await db.query(
    `SELECT COALESCE(SUM(oi.quantity), 0)::int AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.shift_id = $1 AND o.status = 'paid'`,
    [shiftId]
  );
  const refundsTotal = r2(f.refunds.reduce((a, r) => a + Number(r.total), 0));
  const expected = shift.status === 'closed' ? Number(shift.expected_cash) : r2(Number(shift.opening_float) + f.cashIn - f.cashOut);
  res.json({
    shift,
    sales: { count: sales[0].count, gross: Number(sales[0].gross), discounts: Number(sales[0].discounts), tax: Number(sales[0].tax), units: items[0].units },
    payments: f.payments.map((p) => ({ method: p.method, total: Number(p.total), orders: p.orders })),
    refunds: { total: refundsTotal, byMethod: f.refunds.map((r) => ({ method: r.method, total: Number(r.total), count: r.count })) },
    net: r2(Number(sales[0].gross) - refundsTotal),
    cash: {
      openingFloat: Number(shift.opening_float), cashSales: f.cashIn, cashRefunds: f.cashOut, expected,
      counted: shift.counted_cash == null ? null : Number(shift.counted_cash),
      variance: shift.counted_cash == null ? null : r2(Number(shift.counted_cash) - expected),
    },
  });
}

// GET /api/stores/:storeId/reports/daily?date=YYYY-MM-DD  (store time zone; default = today there)
async function dailyReport(req, res) {
  res.json(await buildDailyReport(req.params.storeId, req.query.date || null));
}

/** Also used by the end-of-day summary email (jobs/dailySummaryJob.js). */
async function buildDailyReport(storeId, date) {
  const { rows: st } = await db.query('SELECT timezone FROM stores WHERE id = $1', [storeId]);
  const tz = st[0]?.timezone || 'UTC';
  const { rows: d } = await db.query(`SELECT COALESCE($1::date, (now() AT TIME ZONE $2)::date)::text AS day`, [date || null, tz]);
  const day = d[0].day;
  const inDay = (col) => `(${col} AT TIME ZONE $2)::date = $3::date`;

  const { rows: totals } = await db.query(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(discount_amount), 0) AS discounts,
            COALESCE(SUM(tax_amount), 0) AS tax, COALESCE(AVG(total), 0) AS average
     FROM orders WHERE store_id = $1 AND status = 'paid' AND ${inDay('paid_at')}`,
    [storeId, tz, day]
  );
  const { rows: byMethod } = await db.query(
    `SELECT op.method, COALESCE(SUM(op.amount), 0) AS total FROM order_payments op JOIN orders o ON o.id = op.order_id
     WHERE o.store_id = $1 AND o.status = 'paid' AND ${inDay('o.paid_at')} GROUP BY op.method ORDER BY total DESC`,
    [storeId, tz, day]
  );
  const { rows: refunds } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count FROM refunds WHERE store_id = $1 AND ${inDay('created_at')}`,
    [storeId, tz, day]
  );
  const { rows: byHour } = await db.query(
    `SELECT EXTRACT(HOUR FROM paid_at AT TIME ZONE $2)::int AS hour, COUNT(*)::int AS orders, COALESCE(SUM(total), 0) AS total
     FROM orders WHERE store_id = $1 AND status = 'paid' AND ${inDay('paid_at')} GROUP BY 1 ORDER BY 1`,
    [storeId, tz, day]
  );
  const { rows: byCashier } = await db.query(
    `SELECT COALESCE(u.name, '—') AS name, COUNT(*)::int AS orders, COALESCE(SUM(o.total), 0) AS total
     FROM orders o LEFT JOIN users u ON u.id = o.paid_by
     WHERE o.store_id = $1 AND o.status = 'paid' AND ${inDay('o.paid_at')} GROUP BY u.name ORDER BY total DESC`,
    [storeId, tz, day]
  );
  const { rows: topItems } = await db.query(
    `SELECT p.name, SUM(oi.quantity)::int AS units, COALESCE(SUM(oi.line_total), 0) AS total
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
     WHERE o.store_id = $1 AND o.status = 'paid' AND ${inDay('o.paid_at')}
     GROUP BY p.name ORDER BY units DESC LIMIT 10`,
    [storeId, tz, day]
  );
  const num = (rows, keys) => rows.map((r) => { const o = { ...r }; keys.forEach((k) => { o[k] = Number(o[k]); }); return o; });
  const t = totals[0];
  return ({
    date: day instanceof Date ? day.toISOString().slice(0, 10) : String(day), timezone: tz,
    orders: t.orders, gross: Number(t.gross), discounts: Number(t.discounts), tax: Number(t.tax), average: r2(t.average),
    refunds: { total: Number(refunds[0].total), count: refunds[0].count },
    net: r2(Number(t.gross) - Number(refunds[0].total)),
    byMethod: num(byMethod, ['total']), byHour: num(byHour, ['total']), byCashier: num(byCashier, ['total']), topItems: num(topItems, ['total']),
  });
}

module.exports = { currentShift, openShift, closeShift, listShifts, shiftReport, dailyReport, buildDailyReport };

const crypto = require('crypto');
const db = require('../db');
const { localDate, todayIn, utcWindowFor } = require('../utils/tz');
const { roundQty } = require('../utils/qty');
const { notifyManagers } = require('./handoverController');

// Exit check (security post) and the per-role home screens, offline.
// Same behaviour as backend/src/controllers/roleDashboardController.js.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// The QR holds a link like https://…/r/<public_token>; staff may also type the receipt number.
function parseCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/r\/([A-Za-z0-9_-]+)/);
  return m ? { token: m[1] } : { any: s };
}

function findReceipt(storeId, raw) {
  const c = parseCode(raw);
  if (!c.token && !c.any) return null;
  const order = db.prepare(
    `SELECT o.id, o.status, o.receipt_number, o.total, o.refunded_total, o.payment_method, o.paid_at,
            o.exit_checked_at, o.exit_status, o.exit_note, cu.name AS cashier_name, ck.name AS checked_by_name
     FROM orders o LEFT JOIN users cu ON cu.id = o.paid_by LEFT JOIN users ck ON ck.id = o.exit_checked_by
     WHERE o.store_id = ? AND (o.public_token = ? OR upper(o.receipt_number) = upper(?)) LIMIT 1`
  ).get(storeId, c.token || c.any, c.any || c.token);
  if (!order) return null;
  const items = db.prepare(
    `SELECT oi.id, oi.quantity, oi.line_total, p.name,
            COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0) AS refunded_qty,
            COALESCE((SELECT SUM(sr.quantity) FROM security_returns sr WHERE sr.order_item_id = oi.id), 0) AS returned_qty
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY p.name`
  ).all(order.id);
  return { ...order, items };
}

// GET /api/stores/:storeId/exit-check?code=…
function lookup(req, res) {
  const receipt = findReceipt(req.params.storeId, req.query.code);
  if (!receipt) return res.status(404).json({ error: 'No receipt with that code in this store. Ask for the receipt or call the manager.' });
  res.json(receipt);
}

// POST /api/stores/:storeId/exit-check/:orderId  { result: 'passed' | 'mismatch', note? }
function markChecked(req, res) {
  const { storeId, orderId } = req.params;
  const result = req.body?.result === 'mismatch' ? 'mismatch' : 'passed';
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (result === 'mismatch' && !note) return res.status(400).json({ error: 'Describe what did not match (e.g. 3 bags of rice going out, receipt shows 2).' });
  const r = db.prepare(
    `UPDATE orders SET exit_checked_at = ${NOW}, exit_checked_by = ?, exit_status = ?, exit_note = ?
     WHERE id = ? AND store_id = ? AND status = 'paid' AND exit_checked_at IS NULL`
  ).run(req.user.sub || null, result, note, orderId, storeId);
  if (r.changes) {
    const row = db.prepare('SELECT id, exit_checked_at, exit_status, receipt_number FROM orders WHERE id = ?').get(orderId);
    if (result === 'mismatch') {
      const who = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub)?.name || 'Security';
      notifyManagers(storeId, 'exit_mismatch', `Exit check mismatch on receipt ${row.receipt_number} (flagged by ${who}): ${note}`);
      try { require('../realtime').emitToStore(storeId, 'notification:new', { type: 'exit_mismatch' }); } catch { /* realtime optional */ }
    }
    return res.json(row);
  }
  const o = db.prepare(
    `SELECT o.status, o.exit_checked_at, u.name AS checked_by_name FROM orders o LEFT JOIN users u ON u.id = o.exit_checked_by WHERE o.id = ? AND o.store_id = ?`
  ).get(orderId, storeId);
  if (!o) return res.status(404).json({ error: 'Receipt not found' });
  if (o.exit_checked_at) return res.status(409).json({ error: 'This receipt was already used at the exit.', exit_checked_at: o.exit_checked_at, checked_by_name: o.checked_by_name });
  return res.status(400).json({ error: 'This order is not paid. Do not let the goods out; call the cashier or manager.' });
}

// POST /api/stores/:storeId/exit-check/:orderId/returns  { items: [{ orderItemId, quantity }], note? }
function confirmReturn(req, res) {
  const { storeId, orderId } = req.params;
  const items = Array.isArray(req.body?.items) ? req.body.items.filter((i) => Number(i.quantity) > 0) : [];
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (!items.length) return res.status(400).json({ error: 'Enter how many of each item came back' });
  try {
    const result = db.transaction(() => {
      const o = db.prepare('SELECT id, status FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
      if (!o || o.status !== 'paid') return { status: 400, body: { error: 'Only a paid sale can have returns' } };
      for (const it of items) {
        const qty = roundQty(it.quantity);
        const line = db.prepare(
          `SELECT oi.quantity, COALESCE((SELECT SUM(sr.quantity) FROM security_returns sr WHERE sr.order_item_id = oi.id), 0) AS returned
           FROM order_items oi WHERE oi.id = ? AND oi.order_id = ?`
        ).get(it.orderItemId, orderId);
        if (!line) throw Object.assign(new Error('x'), { userError: { status: 404, body: { error: 'Item not on this receipt' } } });
        const left = roundQty(Number(line.quantity) - Number(line.returned));
        if (qty > left + 1e-9) throw Object.assign(new Error('x'), { userError: { status: 400, body: { error: `Only ${left} of that item can still come back on this receipt` } } });
        db.prepare('INSERT INTO security_returns (id, store_id, order_id, order_item_id, quantity, note, checked_by) VALUES (?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), storeId, orderId, it.orderItemId, qty, note, req.user.sub || null);
      }
      return { status: 201, body: { message: 'Return received. The customer can now go to the cashier for the refund.' } };
    })();
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not record the return' });
  }
}

// GET /api/stores/:storeId/my-dashboard — only what the signed-in role needs.
function myDashboard(req, res) {
  const { storeId } = req.params;
  const { role, sub } = req.user;
  const tz = db.prepare('SELECT timezone FROM stores WHERE id = ?').get(storeId)?.timezone || 'UTC';
  const today = todayIn(tz);
  const [from, to] = utcWindowFor(today);
  const isToday = (iso) => iso && localDate(iso, tz) === today;
  const out = { role };
  const salesToday = (extra = '', params = []) => {
    const rows = db.prepare(`SELECT total, refunded_total, paid_at FROM orders WHERE store_id = ? AND status = 'paid' AND paid_at BETWEEN ? AND ? ${extra}`)
      .all(storeId, from, to, ...params).filter((o) => isToday(o.paid_at));
    return { count: rows.length, total: Math.round(rows.reduce((s, o) => s + Number(o.total) - Number(o.refunded_total || 0), 0) * 100) / 100 };
  };

  if (['admin', 'manager'].includes(role)) {
    Object.assign(out, { storeSalesToday: salesToday(), storeTier: db.prepare('SELECT store_tier FROM stores WHERE id = ?').get(storeId)?.store_tier });
  } else if (['cashier', 'checkout'].includes(role)) {
    const recent = db.prepare(
      `SELECT id, receipt_number, total, payment_method, paid_at FROM orders WHERE store_id = ? AND status = 'paid' AND (paid_by = ? OR created_by = ?) ORDER BY paid_at DESC LIMIT 6`
    ).all(storeId, sub, sub);
    const shift = db.prepare(`SELECT id, opened_at FROM shifts WHERE store_id = ? AND opened_by = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`).get(storeId, sub);
    const parked = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND status = 'pending_payment' AND created_by = ?`).get(storeId, sub).n;
    Object.assign(out, { salesToday: salesToday('AND (paid_by = ? OR created_by = ?)', [sub, sub]), recentSales: recent, openShift: shift || null, parkedOrders: parked });
  } else if (role === 'staff') {
    const low = db.prepare(
      `SELECT id, name, shelf_qty, backroom_qty, reorder_level FROM products WHERE store_id = ? AND archived_at IS NULL AND shelf_qty <= reorder_level ORDER BY shelf_qty ASC, name LIMIT 8`
    ).all(storeId);
    const mine = db.prepare(
      `SELECT m.type, m.quantity, m.created_at, p.name FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE m.store_id = ? AND m.performed_by = ? ORDER BY m.created_at DESC LIMIT 6`
    ).all(storeId, sub);
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM cycle_count_tasks WHERE store_id = ? AND status = 'pending'`).get(storeId).n;
    Object.assign(out, { shelfToRefill: low, myMovements: mine, countTasks: tasks });
  } else if (['stock_taker', 'auditor'].includes(role)) {
    const mineToday = db.prepare(`SELECT discrepancy, created_at FROM shelf_audits WHERE store_id = ? AND performed_by = ? AND created_at BETWEEN ? AND ?`)
      .all(storeId, sub, from, to).filter((a) => isToday(a.created_at));
    const recent = db.prepare(
      `SELECT a.counted_qty, a.expected_qty, a.discrepancy, a.created_at, p.name FROM shelf_audits a JOIN products p ON p.id = a.product_id WHERE a.store_id = ? AND a.performed_by = ? ORDER BY a.created_at DESC LIMIT 8`
    ).all(storeId, sub);
    Object.assign(out, { countsToday: { today: mineToday.length, mismatches: mineToday.filter((a) => a.discrepancy !== 0).length }, recentCounts: recent });
  } else if (role === 'marketplace_manager') {
    // Online orders live in the cloud; the Online Orders page fetches them when connected.
    Object.assign(out, { openOrders: {}, fulfilledToday: 0, queue: [], online: false });
  } else if (role === 'store_manager') {
    const arrivals = db.prepare('SELECT quantity, created_at FROM stock_arrivals WHERE store_id = ? AND created_at BETWEEN ? AND ?').all(storeId, from, to).filter((a) => isToday(a.created_at));
    const recent = db.prepare(
      `SELECT a.quantity, a.invoice_number, a.created_at, p.name FROM stock_arrivals a JOIN products p ON p.id = a.product_id WHERE a.store_id = ? ORDER BY a.created_at DESC LIMIT 6`
    ).all(storeId);
    const low = db.prepare(
      `SELECT id, name, backroom_qty, reorder_level FROM products WHERE store_id = ? AND archived_at IS NULL AND backroom_qty <= reorder_level ORDER BY backroom_qty ASC, name LIMIT 8`
    ).all(storeId);
    const open = db.prepare(`SELECT COUNT(*) AS n FROM stock_handovers WHERE store_id = ? AND status = 'issued'`).get(storeId).n;
    const short = db.prepare(`SELECT COUNT(*) AS n FROM stock_handovers WHERE store_id = ? AND status = 'short' AND received_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`).get(storeId).n;
    Object.assign(out, {
      deliveriesToday: { n: arrivals.length, units: roundQty(arrivals.reduce((s, a) => s + Number(a.quantity), 0)) },
      recentDeliveries: recent, storeRoomLow: low, handoversOpen: open, handoversShort: short,
    });
  } else if (role === 'shelf_manager') {
    const waiting = db.prepare(
      `SELECT h.id, h.issued_at, u.name AS issued_by_name, COUNT(i.id) AS lines, COALESCE(SUM(i.qty_issued), 0) AS units
       FROM stock_handovers h LEFT JOIN users u ON u.id = h.issued_by LEFT JOIN stock_handover_items i ON i.handover_id = h.id
       WHERE h.store_id = ? AND h.status = 'issued' GROUP BY h.id ORDER BY h.issued_at`
    ).all(storeId);
    const low = db.prepare(
      `SELECT id, name, shelf_qty, backroom_qty, reorder_level FROM products WHERE store_id = ? AND archived_at IS NULL AND shelf_qty <= reorder_level ORDER BY shelf_qty ASC, name LIMIT 8`
    ).all(storeId);
    Object.assign(out, { handoversWaiting: waiting, shelfToRefill: low });
  } else if (role === 'security') {
    const mine = db.prepare('SELECT exit_checked_at FROM orders WHERE store_id = ? AND exit_checked_by = ? AND exit_checked_at BETWEEN ? AND ?')
      .all(storeId, sub, from, to).filter((o) => isToday(o.exit_checked_at));
    const recent = db.prepare(
      'SELECT receipt_number, total, exit_checked_at FROM orders WHERE store_id = ? AND exit_checked_by = ? ORDER BY exit_checked_at DESC LIMIT 8'
    ).all(storeId, sub);
    Object.assign(out, { checkedToday: mine.length, recentChecks: recent });
  }
  res.json(out);
}

module.exports = { lookup, markChecked, confirmReturn, myDashboard, parseCode };

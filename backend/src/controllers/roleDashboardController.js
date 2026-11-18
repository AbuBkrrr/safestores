const db = require('../config/db');

// ---------------------------------------------------------------------------
// Exit check (security post): scan the receipt QR, confirm paid, mark checked.
// ---------------------------------------------------------------------------

// The QR holds a link like https://…/r/<public_token>; staff may also type
// the receipt number printed on the slip.
function parseCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/r\/([A-Za-z0-9_-]+)/);
  return m ? { token: m[1] } : { any: s };
}

async function findReceipt(storeId, raw) {
  const c = parseCode(raw);
  if (!c.token && !c.any) return null;
  const { rows } = await db.query(
    `SELECT o.id, o.status, o.receipt_number, o.total, o.refunded_total, o.payment_method, o.paid_at,
            o.exit_checked_at, o.exit_status, o.exit_note, cu.name AS cashier_name, ck.name AS checked_by_name
     FROM orders o LEFT JOIN users cu ON cu.id = o.paid_by LEFT JOIN users ck ON ck.id = o.exit_checked_by
     WHERE o.store_id = $1 AND (o.public_token = $2 OR upper(o.receipt_number) = upper($3))
     LIMIT 1`,
    [storeId, c.token || c.any, c.any || c.token]
  );
  const order = rows[0];
  if (!order) return null;
  const items = await db.query(
    `SELECT oi.id, oi.quantity, oi.line_total, p.name,
            COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0)::int AS refunded_qty,
            COALESCE((SELECT SUM(sr.quantity) FROM security_returns sr WHERE sr.order_item_id = oi.id), 0)::int AS returned_qty
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY p.name`, [order.id]
  );
  return { ...order, items: items.rows };
}

// GET /api/stores/:storeId/exit-check?code=…
async function lookup(req, res) {
  const receipt = await findReceipt(req.params.storeId, req.query.code);
  if (!receipt) return res.status(404).json({ error: 'No receipt with that code in this store. Ask for the receipt or call the manager.' });
  res.json(receipt);
}

// POST /api/stores/:storeId/exit-check/:orderId  — mark as checked out
// body: { result: 'passed' | 'mismatch', note? }
async function markChecked(req, res) {
  const { storeId, orderId } = req.params;
  const result = req.body?.result === 'mismatch' ? 'mismatch' : 'passed';
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (result === 'mismatch' && !note) return res.status(400).json({ error: 'Describe what did not match (e.g. 3 bags of rice going out, receipt shows 2).' });
  const { rows } = await db.query(
    `UPDATE orders SET exit_checked_at = now(), exit_checked_by = $1, exit_status = $4, exit_note = $5
     WHERE id = $2 AND store_id = $3 AND status = 'paid' AND exit_checked_at IS NULL RETURNING id, exit_checked_at, exit_status, receipt_number`,
    [req.user.sub || null, orderId, storeId, result, note]
  );
  if (rows[0]) {
    if (result === 'mismatch') {
      const who = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.sub])).rows[0]?.name || 'Security';
      for (const role of ['admin', 'manager']) {
        await db.query(
          `INSERT INTO store_notifications (store_id, type, severity, audience_role, message) VALUES ($1, 'exit_mismatch', 'amber', $2, $3)`,
          [storeId, role, `Exit check mismatch on receipt ${rows[0].receipt_number} (flagged by ${who}): ${note}`]
        );
      }
      try { require('../realtime').emitToStore(storeId, 'notification:new', { type: 'exit_mismatch' }); } catch { /* realtime optional */ }
    }
    return res.json(rows[0]);
  }
  const cur = await db.query(
    `SELECT o.status, o.exit_checked_at, u.name AS checked_by_name FROM orders o LEFT JOIN users u ON u.id = o.exit_checked_by
     WHERE o.id = $1 AND o.store_id = $2`, [orderId, storeId]
  );
  const o = cur.rows[0];
  if (!o) return res.status(404).json({ error: 'Receipt not found' });
  if (o.exit_checked_at) return res.status(409).json({ error: 'This receipt was already used at the exit.', exit_checked_at: o.exit_checked_at, checked_by_name: o.checked_by_name });
  return res.status(400).json({ error: 'This order is not paid. Do not let the goods out; call the cashier or manager.' });
}

// POST /api/stores/:storeId/exit-check/:orderId/returns  { items: [{ orderItemId, quantity }], note? }
// Security confirms the goods physically came back before any refund.
async function confirmReturn(req, res) {
  const { storeId, orderId } = req.params;
  const items = Array.isArray(req.body?.items) ? req.body.items.filter((i) => parseInt(i.quantity, 10) > 0) : [];
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  if (!items.length) return res.status(400).json({ error: 'Enter how many of each item came back' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT id, status FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE`, [orderId, storeId])).rows[0];
    if (!o || o.status !== 'paid') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only a paid sale can have returns' }); }
    for (const it of items) {
      const qty = parseInt(it.quantity, 10);
      const line = (await client.query(
        `SELECT oi.quantity, COALESCE((SELECT SUM(sr.quantity) FROM security_returns sr WHERE sr.order_item_id = oi.id), 0)::int AS returned
         FROM order_items oi WHERE oi.id = $1 AND oi.order_id = $2`, [it.orderItemId, orderId]
      )).rows[0];
      if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not on this receipt' }); }
      if (qty > line.quantity - line.returned) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Only ${line.quantity - line.returned} of that item can still come back on this receipt` });
      }
      await client.query(
        `INSERT INTO security_returns (store_id, order_id, order_item_id, quantity, note, checked_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [storeId, orderId, it.orderItemId, qty, note, req.user.sub || null]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'Return received. The customer can now go to the cashier for the refund.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record the return' });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /api/stores/:storeId/my-dashboard — only what the signed-in role needs.
// Admin/manager keep the full store dashboard (analytics/summary).
// ---------------------------------------------------------------------------
async function myDashboard(req, res) {
  const { storeId } = req.params;
  const { role, sub } = req.user;
  const tz = (await db.query('SELECT timezone FROM stores WHERE id = $1', [storeId])).rows[0]?.timezone || 'UTC';
  const today = `(now() AT TIME ZONE '${tz.replace(/'/g, '')}')::date`;
  const isToday = (col) => `(${col} AT TIME ZONE '${tz.replace(/'/g, '')}')::date = ${today}`;
  const out = { role };

  if (['cashier', 'checkout'].includes(role)) {
    const s = await db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total - refunded_total), 0) AS total
       FROM orders WHERE store_id = $1 AND status = 'paid' AND (paid_by = $2 OR created_by = $2) AND ${isToday('paid_at')}`, [storeId, sub]
    );
    const recent = await db.query(
      `SELECT id, receipt_number, total, payment_method, paid_at FROM orders
       WHERE store_id = $1 AND status = 'paid' AND (paid_by = $2 OR created_by = $2) ORDER BY paid_at DESC LIMIT 6`, [storeId, sub]
    );
    const shift = await db.query(`SELECT id, opened_at FROM shifts WHERE store_id = $1 AND opened_by = $2 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`, [storeId, sub]);
    const parked = await db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE store_id = $1 AND status = 'pending_payment' AND created_by = $2`, [storeId, sub]);
    Object.assign(out, { salesToday: s.rows[0], recentSales: recent.rows, openShift: shift.rows[0] || null, parkedOrders: parked.rows[0].n });
  } else if (role === 'staff') {
    const low = await db.query(
      `SELECT id, name, shelf_qty, backroom_qty, reorder_level FROM products
       WHERE store_id = $1 AND archived_at IS NULL AND shelf_qty <= reorder_level ORDER BY shelf_qty ASC, name LIMIT 8`, [storeId]
    ).catch(() => db.query(`SELECT id, name, shelf_qty, backroom_qty, reorder_level FROM products WHERE store_id = $1 AND shelf_qty <= reorder_level ORDER BY shelf_qty ASC LIMIT 8`, [storeId]));
    const mine = await db.query(
      `SELECT m.type, m.quantity, m.created_at, p.name FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE m.store_id = $1 AND m.performed_by = $2 ORDER BY m.created_at DESC LIMIT 6`, [storeId, sub]
    );
    const tasks = await db.query(`SELECT COUNT(*)::int AS n FROM cycle_count_tasks WHERE store_id = $1 AND status = 'pending'`, [storeId]).catch(() => ({ rows: [{ n: null }] }));
    Object.assign(out, { shelfToRefill: low.rows, myMovements: mine.rows, countTasks: tasks.rows[0].n });
  } else if (['stock_taker', 'auditor'].includes(role)) {
    const counts = await db.query(
      `SELECT COUNT(*)::int AS today, COALESCE(SUM(CASE WHEN discrepancy <> 0 THEN 1 ELSE 0 END), 0)::int AS mismatches
       FROM shelf_audits WHERE store_id = $1 AND performed_by = $2 AND ${isToday('created_at')}`, [storeId, sub]
    );
    const recent = await db.query(
      `SELECT a.counted_qty, a.expected_qty, a.discrepancy, a.created_at, p.name FROM shelf_audits a JOIN products p ON p.id = a.product_id
       WHERE a.store_id = $1 AND a.performed_by = $2 ORDER BY a.created_at DESC LIMIT 8`, [storeId, sub]
    );
    Object.assign(out, { countsToday: counts.rows[0], recentCounts: recent.rows });
  } else if (role === 'marketplace_manager') {
    const by = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM marketplace_orders WHERE store_id = $1 AND status IN ('placed','confirmed','ready_for_pickup','out_for_delivery') GROUP BY status`, [storeId]
    );
    const fulfilled = await db.query(`SELECT COUNT(*)::int AS n FROM marketplace_orders WHERE store_id = $1 AND status = 'fulfilled' AND ${isToday('fulfilled_at')}`, [storeId]);
    const newest = await db.query(
      `SELECT mo.id, mo.status, mo.total, mo.fulfilment_method, mo.created_at, COALESCE(c.name, mo.guest_name) AS customer_name
       FROM marketplace_orders mo LEFT JOIN customers c ON c.id = mo.customer_id
       WHERE mo.store_id = $1 AND mo.status IN ('placed','confirmed','ready_for_pickup','out_for_delivery') ORDER BY mo.created_at ASC LIMIT 8`, [storeId]
    );
    Object.assign(out, { openOrders: Object.fromEntries(by.rows.map((r) => [r.status, r.n])), fulfilledToday: fulfilled.rows[0].n, queue: newest.rows });
  } else if (role === 'store_manager') {
    const deliveries = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity), 0)::int AS units FROM stock_arrivals WHERE store_id = $1 AND ${isToday('created_at')}`, [storeId]
    );
    const recent = await db.query(
      `SELECT a.quantity, a.invoice_number, a.created_at, p.name FROM stock_arrivals a JOIN products p ON p.id = a.product_id
       WHERE a.store_id = $1 ORDER BY a.created_at DESC LIMIT 6`, [storeId]
    );
    const low = await db.query(
      `SELECT id, name, backroom_qty, reorder_level FROM products WHERE store_id = $1 AND archived_at IS NULL AND backroom_qty <= reorder_level
       ORDER BY backroom_qty ASC, name LIMIT 8`, [storeId]
    );
    const open = await db.query(`SELECT COUNT(*)::int AS n FROM stock_handovers WHERE store_id = $1 AND status = 'issued'`, [storeId]);
    const short = await db.query(`SELECT COUNT(*)::int AS n FROM stock_handovers WHERE store_id = $1 AND status = 'short' AND received_at > now() - INTERVAL '7 days'`, [storeId]);
    Object.assign(out, { deliveriesToday: deliveries.rows[0], recentDeliveries: recent.rows, storeRoomLow: low.rows, handoversOpen: open.rows[0].n, handoversShort: short.rows[0].n });
  } else if (role === 'shelf_manager') {
    const waiting = await db.query(
      `SELECT h.id, h.issued_at, u.name AS issued_by_name, COUNT(i.id)::int AS lines, COALESCE(SUM(i.qty_issued), 0)::int AS units
       FROM stock_handovers h LEFT JOIN users u ON u.id = h.issued_by LEFT JOIN stock_handover_items i ON i.handover_id = h.id
       WHERE h.store_id = $1 AND h.status = 'issued' GROUP BY h.id, u.name ORDER BY h.issued_at`, [storeId]
    );
    const low = await db.query(
      `SELECT id, name, shelf_qty, backroom_qty, reorder_level FROM products WHERE store_id = $1 AND archived_at IS NULL AND shelf_qty <= reorder_level
       ORDER BY shelf_qty ASC, name LIMIT 8`, [storeId]
    );
    Object.assign(out, { handoversWaiting: waiting.rows, shelfToRefill: low.rows });
  } else if (role === 'security') {
    const c = await db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE store_id = $1 AND exit_checked_by = $2 AND ${isToday('exit_checked_at')}`, [storeId, sub]);
    const recent = await db.query(
      `SELECT receipt_number, total, exit_checked_at FROM orders WHERE store_id = $1 AND exit_checked_by = $2 ORDER BY exit_checked_at DESC LIMIT 8`, [storeId, sub]
    );
    Object.assign(out, { checkedToday: c.rows[0].n, recentChecks: recent.rows });
  }
  res.json(out);
}

module.exports = { lookup, markChecked, confirmReturn, myDashboard, parseCode };

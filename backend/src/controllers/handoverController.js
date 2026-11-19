const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { emitToStore } = require('../realtime');

// Store room → shelf handovers. The store manager issues; the shelf manager
// confirms what actually arrived. Stock moves only on confirmation.

// GET /api/stores/:storeId/handovers
async function listHandovers(req, res) {
  const { rows } = await db.query(
    `SELECT h.*, ib.name AS issued_by_name, rb.name AS received_by_name,
            COALESCE(json_agg(json_build_object('id', i.id, 'product_id', i.product_id, 'name', p.name,
              'qty_issued', i.qty_issued, 'qty_received', i.qty_received, 'backroom_qty', p.backroom_qty) ORDER BY p.name)
              FILTER (WHERE i.id IS NOT NULL), '[]') AS items
     FROM stock_handovers h
     LEFT JOIN stock_handover_items i ON i.handover_id = h.id LEFT JOIN products p ON p.id = i.product_id
     LEFT JOIN users ib ON ib.id = h.issued_by LEFT JOIN users rb ON rb.id = h.received_by
     WHERE h.store_id = $1 AND (h.status = 'issued' OR h.issued_at > now() - INTERVAL '14 days')
     GROUP BY h.id, ib.name, rb.name
     ORDER BY (h.status = 'issued') DESC, h.issued_at DESC LIMIT 100`, [req.params.storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/handovers  { items: [{ productId, quantity }], note? }
async function issueHandover(req, res) {
  const { storeId } = req.params;
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map((i) => ({ productId: i.productId, quantity: Math.round(Number(i.quantity) * 1000) / 1000 })).filter((i) => i.productId && i.quantity > 0);
  if (!items.length) return res.status(400).json({ error: 'Add at least one product and quantity' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const p = (await client.query('SELECT name, backroom_qty FROM products WHERE id = $1 AND store_id = $2', [it.productId, storeId])).rows[0];
      if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
      // Count stock already promised to the shelf in other open handovers.
      const pending = (await client.query(
        `SELECT COALESCE(SUM(i.qty_issued), 0) AS n FROM stock_handover_items i JOIN stock_handovers h ON h.id = i.handover_id
         WHERE h.store_id = $1 AND h.status = 'issued' AND i.product_id = $2`, [storeId, it.productId]
      )).rows[0].n;
      const free = Math.max(0, Math.round((Number(p.backroom_qty) - Number(pending)) * 1000) / 1000);
      if (it.quantity > free + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Only ${free} of ${p.name} is free in the store room` });
      }
    }
    const h = (await client.query(
      `INSERT INTO stock_handovers (store_id, note, issued_by) VALUES ($1,$2,$3) RETURNING *`,
      [storeId, String(req.body?.note || '').trim().slice(0, 300) || null, req.user.sub || null]
    )).rows[0];
    for (const it of items) {
      await client.query('INSERT INTO stock_handover_items (handover_id, product_id, qty_issued) VALUES ($1,$2,$3)', [h.id, it.productId, it.quantity]);
    }
    await client.query('COMMIT');
    emitToStore(storeId, 'handover:issued', { id: h.id });
    res.status(201).json(h);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the handover' });
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/handovers/:id/receive  { items: [{ itemId, qtyReceived }], note? }
async function receiveHandover(req, res) {
  const { storeId, id } = req.params;
  const given = new Map((Array.isArray(req.body?.items) ? req.body.items : []).map((i) => [i.itemId, i.qtyReceived === '' || i.qtyReceived === undefined ? NaN : Math.round(Number(i.qtyReceived) * 1000) / 1000]));
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const h = (await client.query('SELECT * FROM stock_handovers WHERE id = $1 AND store_id = $2 FOR UPDATE', [id, storeId])).rows[0];
    if (!h || h.status !== 'issued') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This handover is not waiting to be received' }); }
    if (h.issued_by && h.issued_by === req.user.sub && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'The person who handed the stock over cannot also confirm receiving it' });
    }
    const lines = (await client.query(
      `SELECT i.*, p.name FROM stock_handover_items i JOIN products p ON p.id = i.product_id WHERE i.handover_id = $1`, [id]
    )).rows;
    const short = [];
    for (const l of lines) {
      const got = given.has(l.id) ? given.get(l.id) : NaN;
      if (!(got >= 0) || got > l.qty_issued) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Enter how many of ${l.name} you received (0 to ${l.qty_issued})` });
      }
      await client.query('UPDATE stock_handover_items SET qty_received = $1 WHERE id = $2', [got, l.id]);
      if (got > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'transfer_to_shelf',$3,$4,$5)`,
          [storeId, l.product_id, got, 'Handover from store room', req.user.sub || null]
        );
        await recomputeProductQuantities(client, l.product_id);
      }
      if (got < l.qty_issued) short.push(`${l.name}: sent ${l.qty_issued}, received ${got}`);
    }
    const status = short.length ? 'short' : 'received';
    await client.query(
      'UPDATE stock_handovers SET status = $1, received_by = $2, received_at = now(), receive_note = $3 WHERE id = $4',
      [status, req.user.sub || null, note, id]
    );
    if (short.length) {
      for (const role of ['admin', 'manager']) {
        await client.query(
          `INSERT INTO store_notifications (store_id, type, severity, audience_role, message) VALUES ($1, 'handover_short', 'amber', $2, $3)`,
          [storeId, role, `Shelf handover short — ${short.join('; ')}${note ? ` (note: ${note})` : ''}. The missing stock is still counted in the store room until it is found or written off.`]
        );
      }
    }
    await client.query('COMMIT');
    emitToStore(storeId, 'handover:received', { id, status });
    res.json({ id, status, short });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not confirm the handover' });
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/handovers/:id/cancel
async function cancelHandover(req, res) {
  const { rows } = await db.query(
    `UPDATE stock_handovers SET status = 'cancelled' WHERE id = $1 AND store_id = $2 AND status = 'issued' RETURNING id`,
    [req.params.id, req.params.storeId]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only a handover not yet received can be cancelled' });
  res.json({ id: rows[0].id, status: 'cancelled' });
}

// GET /api/stores/:storeId/returns — goods security received back from customers
async function listReturns(req, res) {
  const { rows } = await db.query(
    `SELECT sr.id, sr.quantity, sr.note, sr.created_at, sr.received_at, sr.qty_resellable, sr.qty_damaged, sr.receive_note,
            p.name AS product_name, o.receipt_number, ck.name AS checked_by_name, rb.name AS received_by_name
     FROM security_returns sr JOIN order_items oi ON oi.id = sr.order_item_id JOIN products p ON p.id = oi.product_id
     JOIN orders o ON o.id = sr.order_id LEFT JOIN users ck ON ck.id = sr.checked_by LEFT JOIN users rb ON rb.id = sr.received_by
     WHERE sr.store_id = $1 AND (sr.received_at IS NULL OR sr.received_at > now() - INTERVAL '14 days')
     ORDER BY (sr.received_at IS NULL) DESC, sr.created_at DESC LIMIT 100`, [req.params.storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/returns/:id/receive  { resellable, damaged, note? }
// Store manager takes the returned goods from security into the store room.
async function receiveReturn(req, res) {
  const { storeId, id } = req.params;
  const resellable = Math.round(Number(req.body?.resellable) * 1000) / 1000;
  const damaged = Math.round(Number(req.body?.damaged) * 1000) / 1000;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT sr.*, oi.product_id, o.receipt_number FROM security_returns sr JOIN order_items oi ON oi.id = sr.order_item_id
       JOIN orders o ON o.id = sr.order_id WHERE sr.id = $1 AND sr.store_id = $2 FOR UPDATE OF sr`, [id, storeId]
    )).rows[0];
    if (!r || r.received_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This return is not waiting to be received' }); }
    if (!(resellable >= 0) || !(damaged >= 0) || Math.abs(resellable + damaged - Number(r.quantity)) > 0.0005) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Split all ${r.quantity} returned unit(s) into resellable and damaged` });
    }
    if (r.checked_by && r.checked_by === req.user.sub && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'The person who took the return from the customer cannot also receive it into the store room' });
    }
    const note = `Customer return, receipt ${r.receipt_number}`;
    if (resellable > 0) {
      await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'customer_return',$3,$4,$5)`,
        [storeId, r.product_id, resellable, note, req.user.sub || null]);
    }
    if (damaged > 0) {
      await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'return_damaged',$3,$4,$5)`,
        [storeId, r.product_id, damaged, `${note} (damaged, written off)`, req.user.sub || null]);
    }
    await recomputeProductQuantities(client, r.product_id);
    await client.query(
      `UPDATE security_returns SET received_by = $1, received_at = now(), qty_resellable = $2, qty_damaged = $3, receive_note = $4 WHERE id = $5`,
      [req.user.sub || null, resellable, damaged, String(req.body?.note || '').trim().slice(0, 300) || null, id]
    );
    await client.query('COMMIT');
    emitToStore(storeId, 'handover:received', { id });
    res.json({ id, resellable, damaged });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not receive the return' });
  } finally {
    client.release();
  }
}

module.exports = { listHandovers, issueHandover, receiveHandover, cancelHandover, listReturns, receiveReturn };

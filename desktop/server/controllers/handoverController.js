const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { emitToStore } = require('../realtime');
const { roundQty } = require('../utils/qty');

// Store room → shelf handovers, and goods customers bring back to security.
// Same rules as the cloud edition (backend/src/controllers/handoverController.js):
// stock moves only when the receiver confirms, and the person who sent it
// cannot also confirm receiving it.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const DAYS_AGO = (n) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${n} days')`;

function notifyManagers(storeId, type, message) {
  const ins = db.prepare(`INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message) VALUES (?,?,?,'amber',?,?)`);
  for (const role of ['admin', 'manager']) ins.run(crypto.randomUUID(), storeId, type, role, message);
}

// GET /api/stores/:storeId/handovers
function listHandovers(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT h.*, ib.name AS issued_by_name, rb.name AS received_by_name FROM stock_handovers h
     LEFT JOIN users ib ON ib.id = h.issued_by LEFT JOIN users rb ON rb.id = h.received_by
     WHERE h.store_id = ? AND (h.status = 'issued' OR h.issued_at > ${DAYS_AGO(14)})
     ORDER BY (h.status = 'issued') DESC, h.issued_at DESC LIMIT 100`
  ).all(storeId);
  const items = db.prepare(
    `SELECT i.id, i.product_id, p.name, i.qty_issued, i.qty_received, p.backroom_qty FROM stock_handover_items i
     JOIN products p ON p.id = i.product_id WHERE i.handover_id = ? ORDER BY p.name`
  );
  res.json(rows.map((h) => ({ ...h, items: items.all(h.id) })));
}

// POST /api/stores/:storeId/handovers  { items: [{ productId, quantity }], note? }
function issueHandover(req, res) {
  const { storeId } = req.params;
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map((i) => ({ productId: i.productId, quantity: roundQty(i.quantity) })).filter((i) => i.productId && i.quantity > 0);
  if (!items.length) return res.status(400).json({ error: 'Add at least one product and quantity' });
  const id = req.body?.id || crypto.randomUUID();
  try {
    const result = db.transaction(() => {
      for (const it of items) {
        const p = db.prepare('SELECT name, backroom_qty FROM products WHERE id = ? AND store_id = ?').get(it.productId, storeId);
        if (!p) return { status: 404, body: { error: 'Product not found' } };
        // Stock already promised to the shelf in other open handovers.
        const pending = db.prepare(
          `SELECT COALESCE(SUM(i.qty_issued), 0) AS n FROM stock_handover_items i JOIN stock_handovers h ON h.id = i.handover_id
           WHERE h.store_id = ? AND h.status = 'issued' AND i.product_id = ?`
        ).get(storeId, it.productId).n;
        const free = Math.max(0, roundQty(Number(p.backroom_qty) - Number(pending)));
        if (it.quantity > free + 1e-9) return { status: 400, body: { error: `Only ${free} of ${p.name} is free in the store room` } };
      }
      db.prepare('INSERT INTO stock_handovers (id, store_id, note, issued_by) VALUES (?,?,?,?)')
        .run(id, storeId, String(req.body?.note || '').trim().slice(0, 300) || null, req.user.sub || null);
      const ins = db.prepare('INSERT INTO stock_handover_items (id, handover_id, product_id, qty_issued) VALUES (?,?,?,?)');
      for (const it of items) ins.run(crypto.randomUUID(), id, it.productId, it.quantity);
      return { status: 201, body: db.prepare('SELECT * FROM stock_handovers WHERE id = ?').get(id) };
    })();
    if (result.status === 201) emitToStore(storeId, 'handover:issued', { id });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create the handover' });
  }
}

// POST /api/stores/:storeId/handovers/:id/receive  { items: [{ itemId, qtyReceived }], note? }
function receiveHandover(req, res) {
  const { storeId, id } = req.params;
  const given = new Map((Array.isArray(req.body?.items) ? req.body.items : [])
    .map((i) => [i.itemId, i.qtyReceived === '' || i.qtyReceived === undefined ? NaN : roundQty(i.qtyReceived)]));
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;
  try {
    const result = db.transaction(() => {
      const h = db.prepare('SELECT * FROM stock_handovers WHERE id = ? AND store_id = ?').get(id, storeId);
      if (!h || h.status !== 'issued') return { status: 400, body: { error: 'This handover is not waiting to be received' } };
      if (h.issued_by && h.issued_by === req.user.sub && req.user.role !== 'admin') {
        return { status: 403, body: { error: 'The person who handed the stock over cannot also confirm receiving it' } };
      }
      const lines = db.prepare('SELECT i.*, p.name FROM stock_handover_items i JOIN products p ON p.id = i.product_id WHERE i.handover_id = ?').all(id);
      const short = [];
      for (const l of lines) {
        const got = given.has(l.id) ? given.get(l.id) : NaN;
        if (!(got >= 0) || got > l.qty_issued + 1e-9) {
          throw Object.assign(new Error('bad qty'), { userError: { status: 400, body: { error: `Enter how many of ${l.name} you received (0 to ${l.qty_issued})` } } });
        }
        db.prepare('UPDATE stock_handover_items SET qty_received = ? WHERE id = ?').run(got, l.id);
        if (got > 0) {
          db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'transfer_to_shelf',?,?,?)`)
            .run(crypto.randomUUID(), storeId, l.product_id, got, 'Handover from store room', req.user.sub || null);
          recomputeProductQuantities(db, l.product_id);
        }
        if (got < l.qty_issued) short.push(`${l.name}: sent ${l.qty_issued}, received ${got}`);
      }
      const status = short.length ? 'short' : 'received';
      db.prepare(`UPDATE stock_handovers SET status = ?, received_by = ?, received_at = ${NOW}, receive_note = ? WHERE id = ?`)
        .run(status, req.user.sub || null, note, id);
      if (short.length) {
        notifyManagers(storeId, 'handover_short', `Shelf handover short — ${short.join('; ')}${note ? ` (note: ${note})` : ''}. The missing stock is still counted in the store room until it is found or written off.`);
      }
      return { status: 200, body: { id, status, short } };
    })();
    if (result.status === 200) emitToStore(storeId, 'handover:received', { id, status: result.body.status });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not confirm the handover' });
  }
}

// POST /api/stores/:storeId/handovers/:id/cancel
function cancelHandover(req, res) {
  const r = db.prepare(`UPDATE stock_handovers SET status = 'cancelled' WHERE id = ? AND store_id = ? AND status = 'issued'`).run(req.params.id, req.params.storeId);
  if (!r.changes) return res.status(400).json({ error: 'Only a handover not yet received can be cancelled' });
  res.json({ id: req.params.id, status: 'cancelled' });
}

// GET /api/stores/:storeId/returns — goods security received back from customers
function listReturns(req, res) {
  res.json(db.prepare(
    `SELECT sr.id, sr.quantity, sr.note, sr.created_at, sr.received_at, sr.qty_resellable, sr.qty_damaged, sr.receive_note,
            p.name AS product_name, o.receipt_number, ck.name AS checked_by_name, rb.name AS received_by_name
     FROM security_returns sr JOIN order_items oi ON oi.id = sr.order_item_id JOIN products p ON p.id = oi.product_id
     JOIN orders o ON o.id = sr.order_id LEFT JOIN users ck ON ck.id = sr.checked_by LEFT JOIN users rb ON rb.id = sr.received_by
     WHERE sr.store_id = ? AND (sr.received_at IS NULL OR sr.received_at > ${DAYS_AGO(14)})
     ORDER BY (sr.received_at IS NULL) DESC, sr.created_at DESC LIMIT 100`
  ).all(req.params.storeId));
}

// POST /api/stores/:storeId/returns/:id/receive  { resellable, damaged, note? }
function receiveReturn(req, res) {
  const { storeId, id } = req.params;
  const resellable = roundQty(req.body?.resellable);
  const damaged = roundQty(req.body?.damaged);
  try {
    const result = db.transaction(() => {
      const r = db.prepare(
        `SELECT sr.*, oi.product_id, o.receipt_number FROM security_returns sr JOIN order_items oi ON oi.id = sr.order_item_id
         JOIN orders o ON o.id = sr.order_id WHERE sr.id = ? AND sr.store_id = ?`
      ).get(id, storeId);
      if (!r || r.received_at) return { status: 400, body: { error: 'This return is not waiting to be received' } };
      if (!(resellable >= 0) || !(damaged >= 0) || Math.abs(resellable + damaged - Number(r.quantity)) > 0.0005) {
        return { status: 400, body: { error: `Split all ${r.quantity} returned unit(s) into resellable and damaged` } };
      }
      if (r.checked_by && r.checked_by === req.user.sub && req.user.role !== 'admin') {
        return { status: 403, body: { error: 'The person who took the return from the customer cannot also receive it into the store room' } };
      }
      const note = `Customer return, receipt ${r.receipt_number}`;
      const mv = db.prepare('INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,?,?,?,?)');
      if (resellable > 0) mv.run(crypto.randomUUID(), storeId, r.product_id, 'customer_return', resellable, note, req.user.sub || null);
      if (damaged > 0) mv.run(crypto.randomUUID(), storeId, r.product_id, 'return_damaged', damaged, `${note} (damaged, written off)`, req.user.sub || null);
      recomputeProductQuantities(db, r.product_id);
      db.prepare(`UPDATE security_returns SET received_by = ?, received_at = ${NOW}, qty_resellable = ?, qty_damaged = ?, receive_note = ? WHERE id = ?`)
        .run(req.user.sub || null, resellable, damaged, String(req.body?.note || '').trim().slice(0, 300) || null, id);
      return { status: 200, body: { id, resellable, damaged } };
    })();
    if (result.status === 200) emitToStore(storeId, 'handover:received', { id });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not receive the return' });
  }
}

module.exports = { listHandovers, issueHandover, receiveHandover, cancelHandover, listReturns, receiveReturn, notifyManagers };

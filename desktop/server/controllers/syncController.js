const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');

// See backend/src/controllers/syncController.js for the full rationale —
// this is the SQLite-flavored twin used by the desktop/LAN edition.
const PO_STATUS_RANK = { draft: 0, sent: 1, received: 2, cancelled: 2 };
const ORDER_STATUS_RANK = { pending_payment: 0, paid: 1, cancelled: 1 };
const RECEIPT_STATUS_RANK = { pending: 0, applied: 1, rejected: 1 };

// GET /api/stores/:storeId/sync/export?since=<ISO8601>
function exportChanges(req, res) {
  const { storeId } = req.params;
  const since = req.query.since || '1970-01-01T00:00:00.000Z';

  const products = db.prepare('SELECT * FROM products WHERE store_id = ? AND updated_at > ? ORDER BY updated_at ASC').all(storeId, since);
  // Every operational table below stamps who did it (performed_by,
  // created_by, uploaded_by, paid_by...) as a REFERENCES users(id) FK.
  // Users themselves were never part of this sync payload until now —
  // which meant a movement/audit/receipt/order performed by someone who
  // only exists on the ORIGINATING device would fail its FK check on
  // every other device, and SQLite's INSERT OR IGNORE silently drops the
  // entire row on a FK violation, not just the id conflict it's meant to
  // guard against. That's a real, silent data-loss path for a system
  // whose whole premise is not losing data — see importChanges' fallback
  // resolveUser() for the other half of the fix. password_hash is
  // included deliberately: without it, an account created on Device A
  // could never log in on Device B for the same store, which defeats the
  // point of multi-device sync — it travels under the exact same
  // sync_key trust boundary as every other sensitive field here already.
  const users = db.prepare('SELECT * FROM users WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const arrivals = db.prepare('SELECT * FROM stock_arrivals WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const movements = db.prepare('SELECT * FROM stock_movements WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const audits = db.prepare('SELECT * FROM shelf_audits WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const purchaseOrders = db.prepare('SELECT * FROM purchase_orders WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const purchaseOrderItems = db.prepare(
    `SELECT poi.* FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE po.store_id = ? AND po.created_at > ?`
  ).all(storeId, since);
  const batches = db.prepare('SELECT * FROM batches WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  // cycle_count_tasks (the daily scheduling suggestions) are deliberately
  // NOT synced — each device's own daily job independently manages its own
  // task queue, and task ids aren't even comparable across devices the way
  // suppliers' name-based fallback lets those dedupe. cycle_counts (the
  // actual completed count events) DO sync, append-only, same as audits —
  // that's the real work product and what stock recompute depends on.
  const cycleCounts = db.prepare('SELECT * FROM cycle_counts WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const receipts = db.prepare('SELECT * FROM receipts WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since)
    .map((r) => ({ ...r, parsed_items: JSON.parse(r.parsed_items) }));
  // Orders re-export when paid or cancelled later (a parked sale), not only when created.
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? AND (created_at > ? OR paid_at > ? OR cancelled_at > ?) ORDER BY created_at ASC').all(storeId, since, since, since);
  const orderItems = db.prepare(
    `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.store_id = ? AND (o.created_at > ? OR o.paid_at > ? OR o.cancelled_at > ?)`
  ).all(storeId, since, since, since);
  // v26 till data: shifts, split payments, refunds.
  const shifts = db.prepare('SELECT * FROM shifts WHERE store_id = ? AND (opened_at > ? OR closed_at > ?) ORDER BY opened_at ASC').all(storeId, since, since);
  const orderPayments = db.prepare('SELECT * FROM order_payments WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const refunds = db.prepare('SELECT * FROM refunds WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const refundItems = db.prepare(
    'SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.store_id = ? AND r.created_at > ?'
  ).all(storeId, since);
  // updated_at, not created_at — a webhook edited (or soft-deleted) long
  // after creation still needs to show up in an incremental export.
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE store_id = ? AND updated_at > ? ORDER BY updated_at ASC').all(storeId, since);

  res.json({
    serverTime: new Date().toISOString(),
    users, products, arrivals, movements, audits,
    suppliers, purchaseOrders, purchaseOrderItems, batches, receipts, orders, orderItems, webhooks, cycleCounts,
    shifts, orderPayments, refunds, refundItems,
  });
}

// POST /api/stores/:storeId/sync/import — merges a batch pulled from a
// peer or the cloud into this local database. Idempotent (INSERT OR
// IGNORE keyed by the original id) and safe regardless of merge order —
// quantities are always recomputed from the fully-merged local event log
// afterward, never copied from the remote row directly. Mutable-status
// tables (purchase_orders/receipts/orders) use a rank comparison instead,
// so an out-of-order sync can't revert one that's already progressed
// further locally — see PO_STATUS_RANK etc. above.
function importChanges(req, res) {
  const { storeId } = req.params;
  const {
    users = [], products = [], arrivals = [], movements = [], audits = [],
    suppliers = [], purchaseOrders = [], purchaseOrderItems = [], batches = [],
    receipts = [], orders = [], orderItems = [], webhooks = [], cycleCounts = [],
    shifts = [], orderPayments = [], refunds = [], refundItems = [],
  } = req.body;
  const touched = new Set();

  const run = db.transaction(() => {
    // Import order matters and is NOT arbitrary, despite what the movement
    // loop's old comment used to claim: users → suppliers → products
    // first, since almost everything else below references one of those
    // three. Get this wrong (as it was before) and a brand-new device's
    // very first full sync — products and their movements arriving in the
    // SAME batch, nothing existing locally yet — fails immediately: a
    // movement inserted before its product exists violates the FK and
    // (same class of bug as the user-attribution issue above) either
    // silently vanishes or throws and rolls back the whole batch.

    // Users import FIRST, before anything that references one — so a
    // movement/audit/etc. arriving in the SAME batch as the user who
    // performed it resolves correctly (SQLite sees the INSERT within this
    // transaction immediately, no separate round-trip needed). INSERT OR
    // IGNORE naturally covers both the id-PK conflict (already synced
    // before) and the (store_id, email) UNIQUE conflict (this person
    // already has a local account under a different id — see resolveUser
    // below for why that case still isn't fully lost).
    for (const u of users) {
      db.prepare(
        `INSERT OR IGNORE INTO users (id, store_id, name, email, password_hash, role, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(u.id, storeId, u.name, u.email, u.password_hash, u.role, u.status, u.created_at);
    }

    // Defense in depth for every performed_by/created_by/etc. column
    // below: even with users now syncing, a reference can still fail to
    // resolve locally — the referenced user might not have synced yet
    // (LAN peer offline, cloud sync not yet run), or (rarer) the same
    // person independently ended up with two different local ids on two
    // devices that hadn't synced users with each other before either
    // created data. Either way, the right failure mode is losing the
    // ATTRIBUTION, not the entire operational record — a stock movement
    // missing its "performed by" is a minor gap; a stock movement that
    // silently never arrived at all corrupts the actual inventory count
    // against reality. INSERT OR IGNORE with an unresolvable FK does the
    // latter (drops the whole row) under `foreign_keys = ON`, so every
    // insert below pre-resolves its user reference(s) through this first.
    const knownUserIds = new Set(db.prepare('SELECT id FROM users WHERE store_id = ?').all(storeId).map((r) => r.id));
    const resolveUser = (id) => (id && knownUserIds.has(id) ? id : null);

    // Suppliers dedupe on (store_id, name), not id — two devices can
    // independently create "the same supplier" (identical name) with
    // different generated ids before ever syncing; name is the real
    // identity here (see utils/supplierLookup.js), so that's what dedupes.
    // INSERT OR IGNORE naturally covers both the id-PK conflict and the
    // name-UNIQUE conflict in SQLite.
    const supplierIdRemap = new Map();
    for (const s of suppliers) {
      db.prepare(
        `INSERT OR IGNORE INTO suppliers (id, store_id, name, contact_name, phone, email, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(s.id, storeId, s.name, s.contact_name, s.phone, s.email, s.notes, s.created_at);
      const stored = db.prepare('SELECT id FROM suppliers WHERE store_id = ? AND name = ?').get(storeId, s.name);
      if (stored && stored.id !== s.id) supplierIdRemap.set(s.id, stored.id);
    }
    const resolveSupplierId = (id) => (id ? (supplierIdRemap.get(id) || id) : id);

    // Products: metadata (name/sku/price/location/etc.) is NOT event-sourced,
    // so it's merged last-write-wins by comparing updated_at. Quantities
    // are never taken from the remote row directly — they're recomputed
    // at the end from this database's own (now-merged) movement log, since
    // a third device's movements might already be here that the remote
    // side doesn't know about.
    for (const p of products) {
      const supplierId = resolveSupplierId(p.supplier_id);
      const existing = db.prepare('SELECT id, updated_at FROM products WHERE id = ?').get(p.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO products (id, store_id, name, sku, category, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level,
                  lead_time_days, min_order_qty, auto_reorder, archived_at, brand, image_url, storage_type, backroom_qty, shelf_qty, sold_qty, damaged_qty, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,?)`
        ).run(p.id, storeId, p.name, p.sku, p.category, p.supplier, supplierId, p.unit, p.location, p.cost_price, p.price_multiplier,
          p.reorder_level, p.lead_time_days, p.min_order_qty, p.auto_reorder ? 1 : 0, p.archived_at, p.brand, p.image_url, p.storage_type || 'ambient', p.created_at, p.updated_at);
        touched.add(p.id);
      } else if (new Date(p.updated_at) > new Date(existing.updated_at)) {
        db.prepare(
          `UPDATE products SET name=?, sku=?, category=?, supplier=?, supplier_id=?, unit=?, location=?, cost_price=?, price_multiplier=?,
                  reorder_level=?, lead_time_days=?, min_order_qty=?, auto_reorder=?, archived_at=?, brand=?, image_url=?, storage_type=?, updated_at=? WHERE id=?`
        ).run(p.name, p.sku, p.category, p.supplier, supplierId, p.unit, p.location, p.cost_price, p.price_multiplier,
          p.reorder_level, p.lead_time_days, p.min_order_qty, p.auto_reorder ? 1 : 0, p.archived_at, p.brand, p.image_url, p.storage_type || 'ambient', p.updated_at, p.id);
        touched.add(p.id);
      }
    }
    // Barcode / pack size / variant link travel with the product (v26 columns).
    for (const p of products) {
      if (p.barcode === undefined && p.pack_size === undefined) continue;
      db.prepare(
        `UPDATE products SET barcode = ?, pack_size = ?, variant_of = (SELECT id FROM products WHERE id = ?)
         WHERE id = ? AND updated_at = ?`
      ).run(p.barcode || null, Number(p.pack_size) || 1, p.variant_of || null, p.id, p.updated_at);
    }

    for (const m of movements) {
      db.prepare(
        `INSERT OR IGNORE INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(m.id, storeId, m.product_id, m.type, m.quantity, m.note, resolveUser(m.performed_by), m.created_at);
      touched.add(m.product_id);
    }
    for (const a of arrivals) {
      db.prepare(
        `INSERT OR IGNORE INTO stock_arrivals (id, store_id, product_id, quantity, invoice_number, expiry_date, batch_number, receipt_id, received_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(a.id, storeId, a.product_id, a.quantity, a.invoice_number, a.expiry_date, a.batch_number, a.receipt_id, resolveUser(a.received_by), a.created_at);
    }
    for (const au of audits) {
      db.prepare(
        `INSERT OR IGNORE INTO shelf_audits (id, store_id, product_id, counted_qty, expected_qty, discrepancy, confidence_source, auto_adjusted, performed_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(au.id, storeId, au.product_id, au.counted_qty, au.expected_qty, au.discrepancy, au.confidence_source, au.auto_adjusted ? 1 : 0, resolveUser(au.performed_by), au.created_at);
    }

    // Append-only, same reasoning as shelf_audits above — the stock
    // adjustment (if any) is a separate stock_movements row that syncs
    // and recomputes independently, so importing a count record itself
    // never needs to trigger a recompute here.
    for (const cc of cycleCounts) {
      db.prepare(
        `INSERT OR IGNORE INTO cycle_counts (id, store_id, product_id, task_id, counted_qty, expected_qty, discrepancy, auto_adjusted, performed_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(cc.id, storeId, cc.product_id, cc.task_id || null, cc.counted_qty, cc.expected_qty, cc.discrepancy, cc.auto_adjusted ? 1 : 0, resolveUser(cc.performed_by), cc.created_at);
    }

    for (const po of purchaseOrders) {
      const supplierId = resolveSupplierId(po.supplier_id);
      const existing = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO purchase_orders
            (id, store_id, supplier, supplier_id, status, auto_generated, notes, total_cost, created_by, sent_at, expected_at, received_by, received_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(po.id, storeId, po.supplier, supplierId, po.status, po.auto_generated ? 1 : 0, po.notes, po.total_cost,
          resolveUser(po.created_by), po.sent_at, po.expected_at, resolveUser(po.received_by), po.received_at, po.created_at);
      } else if ((PO_STATUS_RANK[po.status] ?? 0) > (PO_STATUS_RANK[existing.status] ?? 0)) {
        db.prepare(
          'UPDATE purchase_orders SET status=?, sent_at=?, expected_at=?, received_by=?, received_at=? WHERE id=?'
        ).run(po.status, po.sent_at, po.expected_at, resolveUser(po.received_by), po.received_at, po.id);
      }
    }
    for (const item of purchaseOrderItems) {
      const existing = db.prepare('SELECT received_quantity FROM purchase_order_items WHERE id = ?').get(item.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO purchase_order_items (id, purchase_order_id, product_id, quantity, unit_cost, received_quantity)
           VALUES (?,?,?,?,?,?)`
        ).run(item.id, item.purchase_order_id, item.product_id, item.quantity, item.unit_cost, item.received_quantity);
      } else if (item.received_quantity > existing.received_quantity) {
        db.prepare('UPDATE purchase_order_items SET received_quantity=? WHERE id=?').run(item.received_quantity, item.id);
      }
    }

    for (const b of batches) {
      db.prepare(
        `INSERT OR IGNORE INTO batches (id, store_id, product_id, batch_number, expiry_date, quantity_received, arrival_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(b.id, storeId, b.product_id, b.batch_number, b.expiry_date, b.quantity_received, b.arrival_id, b.created_at);
    }

    for (const r of receipts) {
      const existing = db.prepare('SELECT status FROM receipts WHERE id = ?').get(r.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO receipts (id, store_id, image_url, raw_ocr_text, parsed_items, document_date, status, applied_at, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(r.id, storeId, r.image_url, r.raw_ocr_text, JSON.stringify(r.parsed_items || []), r.document_date, r.status, r.applied_at, resolveUser(r.uploaded_by), r.created_at);
      } else if ((RECEIPT_STATUS_RANK[r.status] ?? 0) > (RECEIPT_STATUS_RANK[existing.status] ?? 0)) {
        db.prepare('UPDATE receipts SET status=?, applied_at=? WHERE id=?').run(r.status, r.applied_at, r.id);
      }
    }

    // Shifts before orders (orders/payments point at them). open -> closed only.
    for (const sh of shifts) {
      const ex = db.prepare('SELECT status FROM shifts WHERE id = ?').get(sh.id);
      if (!ex) {
        db.prepare(
          `INSERT OR IGNORE INTO shifts (id, store_id, opened_by, opened_at, opening_float, status, closed_by, closed_at, expected_cash, counted_cash, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(sh.id, storeId, resolveUser(sh.opened_by), sh.opened_at, sh.opening_float, sh.status, resolveUser(sh.closed_by), sh.closed_at, sh.expected_cash, sh.counted_cash, sh.notes);
      } else if (ex.status === 'open' && sh.status === 'closed') {
        db.prepare("UPDATE shifts SET status='closed', closed_by=?, closed_at=?, expected_cash=?, counted_cash=?, notes=? WHERE id=?")
          .run(resolveUser(sh.closed_by), sh.closed_at, sh.expected_cash, sh.counted_cash, sh.notes, sh.id);
      }
    }
    const num = (v) => (v == null ? 0 : Number(v));
    const applyOrderMoney = (o) => db.prepare(
      `UPDATE orders SET discount_type=?, discount_value=?, discount_amount=?, discount_reason=?, discount_approved_by=?,
              tax_rate_pct=?, tax_inclusive=?, tax_amount=?, amount_tendered=?, change_due=?, parked_label=?,
              shift_id=(SELECT id FROM shifts WHERE id = ?),
              store_customer_id=(SELECT id FROM store_customers WHERE id = ? AND store_id = ?),
              public_token=COALESCE(public_token, ?), points_redeemed=?
       WHERE id=?`
    ).run(o.discount_type || null, num(o.discount_value), num(o.discount_amount), o.discount_reason || null, resolveUser(o.discount_approved_by),
      num(o.tax_rate_pct), o.tax_inclusive === undefined || o.tax_inclusive === true || Number(o.tax_inclusive) === 1 ? 1 : 0, num(o.tax_amount),
      o.amount_tendered == null ? null : Number(o.amount_tendered), num(o.change_due), o.parked_label || null, o.shift_id || null,
      o.store_customer_id || null, storeId, o.public_token || null, num(o.points_redeemed), o.id);

    for (const o of orders) {
      const existing = db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO orders (id, store_id, status, subtotal, total, created_by, paid_by, payment_method, receipt_number, created_at, paid_at, cancelled_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(o.id, storeId, o.status, o.subtotal, o.total, resolveUser(o.created_by), resolveUser(o.paid_by), o.payment_method, o.receipt_number, o.created_at, o.paid_at, o.cancelled_at);
        applyOrderMoney(o);
      } else if ((ORDER_STATUS_RANK[o.status] ?? 0) > (ORDER_STATUS_RANK[existing.status] ?? 0)) {
        db.prepare(
          'UPDATE orders SET status=?, paid_by=?, payment_method=?, receipt_number=?, paid_at=?, cancelled_at=? WHERE id=?'
        ).run(o.status, resolveUser(o.paid_by), o.payment_method, o.receipt_number, o.paid_at, o.cancelled_at, o.id);
        applyOrderMoney(o);
      }
    }
    for (const item of orderItems) {
      db.prepare(
        `INSERT OR IGNORE INTO order_items (id, order_id, product_id, quantity, unit_price, line_total, added_via, movement_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(item.id, item.order_id, item.product_id, item.quantity, item.unit_price, item.line_total, item.added_via, item.movement_id, item.created_at);
    }

    // Split tenders and refunds are append-only; refunded_total is re-derived.
    for (const p of orderPayments) {
      db.prepare(
        `INSERT OR IGNORE INTO order_payments (id, order_id, store_id, method, amount, reference, shift_id, created_at)
         SELECT ?,?,?,?,?,?,(SELECT id FROM shifts WHERE id = ?),? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`
      ).run(p.id, p.order_id, storeId, p.method, Number(p.amount), p.reference || null, p.shift_id || null, p.created_at, p.order_id);
    }
    const refundedOrders = new Set();
    for (const r of refunds) {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO refunds (id, order_id, store_id, amount, method, reason, created_by, shift_id, created_at)
         SELECT ?,?,?,?,?,?,?,(SELECT id FROM shifts WHERE id = ?),? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`
      ).run(r.id, r.order_id, storeId, Number(r.amount), r.method, r.reason || null, resolveUser(r.created_by), r.shift_id || null, r.created_at, r.order_id);
      if (ins.changes) refundedOrders.add(r.order_id);
    }
    for (const ri of refundItems) {
      db.prepare(
        `INSERT OR IGNORE INTO refund_items (id, refund_id, order_item_id, product_id, quantity, amount, restocked)
         SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM refunds WHERE id = ?) AND EXISTS (SELECT 1 FROM order_items WHERE id = ?) AND EXISTS (SELECT 1 FROM products WHERE id = ?)`
      ).run(ri.id, ri.refund_id, ri.order_item_id, ri.product_id, ri.quantity, Number(ri.amount), ri.restocked === false || Number(ri.restocked) === 0 ? 0 : 1, ri.refund_id, ri.order_item_id, ri.product_id);
    }
    for (const orderId of refundedOrders) {
      db.prepare('UPDATE orders SET refunded_total = (SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE order_id = ?) WHERE id = ?').run(orderId, orderId);
    }

    for (const productId of touched) {
      if (db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
        recomputeProductQuantities(db, productId);
      }
    }
  });

  try {
    run();
    res.json({
      merged: {
        users: users.length,
        products: products.length, arrivals: arrivals.length, movements: movements.length, audits: audits.length,
        suppliers: suppliers.length, purchaseOrders: purchaseOrders.length, purchaseOrderItems: purchaseOrderItems.length,
        batches: batches.length, receipts: receipts.length, orders: orders.length, orderItems: orderItems.length,
        cycleCounts: cycleCounts.length,
        shifts: shifts.length, orderPayments: orderPayments.length, refunds: refunds.length, refundItems: refundItems.length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import sync batch' });
  }
}

module.exports = { exportChanges, importChanges };

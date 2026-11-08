const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');

// Status "rank" for tables with a mutable lifecycle rather than pure
// append-only history — a lower rank should never overwrite a higher one
// that's already landed locally, since sync order between multiple
// devices/the cloud isn't guaranteed. See importChanges below.
const PO_STATUS_RANK = { draft: 0, sent: 1, received: 2, cancelled: 2 };
const ORDER_STATUS_RANK = { pending_payment: 0, paid: 1, cancelled: 1 };
const RECEIPT_STATUS_RANK = { pending: 0, applied: 1, rejected: 1 };

// GET /api/stores/:storeId/sync/export?since=<ISO8601>
//
// Returns everything that changed after `since`, keyed so a sync agent
// (the Electron LAN relay talking to a peer, or to the cloud) can replay
// each row through the normal idempotent create endpoints on whatever
// server it's merging into. Those endpoints already treat a
// client-supplied `id` as idempotent — see stockMath.js — so replaying
// this export is always safe, no matter how many times or in what order
// it happens.
//
// Covers every table a store would be devastated to lose, not just the
// original four (products/arrivals/movements/audits) — Smart
// Replenishment, Expiry & Batch Tracking, Supplier Performance, and
// scanned receipts all added real business data worth backing up too.
async function exportChanges(req, res) {
  const { storeId } = req.params;
  const since = req.query.since ? new Date(req.query.since) : new Date(0);
  if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'Invalid `since` timestamp' });

  const serverTime = new Date();

  const [
    users, products, arrivals, movements, audits,
    suppliers, purchaseOrders, purchaseOrderItems, batches, receipts, orders, orderItems, webhooks, cycleCounts,
  ] = await Promise.all([
    // Every operational table below stamps who did it (performed_by,
    // created_by, uploaded_by, paid_by...) as a REFERENCES users(id) FK.
    // Users were never part of this payload until now, which meant any
    // row performed by someone who only exists on the ORIGINATING device
    // would fail its FK check here — and because this whole import runs
    // in one transaction, that one failure threw, rolled back, and 500'd
    // the ENTIRE batch, not just that row. Since syncAgent only advances
    // its cursor on success, that meant a store's cloud backup could
    // silently stop advancing entirely, retried forever, never fixing
    // itself. See importChanges' resolveUser() for the rest of the fix —
    // that handles the case where a reference still doesn't resolve
    // locally even with users now syncing (e.g. hasn't synced yet).
    db.query('SELECT * FROM users WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM products WHERE store_id = $1 AND updated_at > $2 ORDER BY updated_at ASC', [storeId, since]),
    db.query('SELECT * FROM stock_arrivals WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM stock_movements WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM shelf_audits WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM suppliers WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM purchase_orders WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query(
      `SELECT poi.* FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.store_id = $1 AND po.created_at > $2`, [storeId, since]
    ),
    db.query('SELECT * FROM batches WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM receipts WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query('SELECT * FROM orders WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
    db.query(
      `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.store_id = $1 AND o.created_at > $2`, [storeId, since]
    ),
    // updated_at, not created_at — a webhook edited (or soft-deleted) long
    // after creation still needs to show up in an incremental export.
    db.query('SELECT * FROM webhooks WHERE store_id = $1 AND updated_at > $2 ORDER BY updated_at ASC', [storeId, since]),
    // cycle_count_tasks (per-device scheduling suggestions) deliberately
    // stay local-only, same reasoning as the desktop-to-desktop sync — see
    // importChanges below for how task_id gets handled on the way in.
    db.query('SELECT * FROM cycle_counts WHERE store_id = $1 AND created_at > $2 ORDER BY created_at ASC', [storeId, since]),
  ]);

  res.json({
    serverTime: serverTime.toISOString(),
    users: users.rows,
    products: products.rows, arrivals: arrivals.rows, movements: movements.rows, audits: audits.rows,
    suppliers: suppliers.rows, purchaseOrders: purchaseOrders.rows, purchaseOrderItems: purchaseOrderItems.rows,
    batches: batches.rows, receipts: receipts.rows, orders: orders.rows, orderItems: orderItems.rows,
    webhooks: webhooks.rows, cycleCounts: cycleCounts.rows,
  });
}

// POST /api/stores/:storeId/sync/import
// body: shape returned by exportChanges — a batch pulled from a peer or
// the cloud, being merged into THIS database.
//
// This is a device-level trust operation (sync-key authenticated, not a
// specific logged-in user — see requireStoreSyncKey), which is why it's a
// separate endpoint from the normal per-user create routes rather than
// reusing them directly: it needs to preserve each row's original author
// and timestamp rather than attributing everything to whichever process
// happens to be running the merge.
async function importChanges(req, res) {
  const { storeId } = req.params;
  const {
    users = [], products = [], arrivals = [], movements = [], audits = [],
    suppliers = [], purchaseOrders = [], purchaseOrderItems = [], batches = [],
    receipts = [], orders = [], orderItems = [], webhooks = [], cycleCounts = [],
  } = req.body;

  const client = await db.pool.connect();
  const touchedProductIds = new Set();
  try {
    await client.query('BEGIN');

    // Users import FIRST, before anything that references one — see
    // exportChanges' comment above for why. ON CONFLICT covers both the
    // id-PK case (already synced) and the (store_id, email) UNIQUE case
    // (this person already has a local account under a different id —
    // resolveUser below is the safety net for that remaining case).
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, store_id, name, email, password_hash, role, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, storeId, u.name, u.email, u.password_hash, u.role, u.status, u.created_at]
      );
    }
    // Defense in depth for every performed_by/created_by/etc. column
    // below: even with users syncing now, a specific reference can still
    // not resolve locally yet (that user's own row hasn't arrived here
    // in an earlier sync round). The right failure mode is losing the
    // ATTRIBUTION alone, not the entire operational record — that's what
    // resolveUser() buys by nulling an unresolvable reference before
    // insert, instead of letting a hard FK violation throw and roll back
    // (and 500) this whole batch, which is what happened before this fix.
    const knownUserIds = new Set(
      (await client.query('SELECT id FROM users WHERE store_id = $1', [storeId])).rows.map((r) => r.id)
    );
    const resolveUser = (id) => (id && knownUserIds.has(id) ? id : null);

    // Suppliers: conflict on (store_id, name) rather than id — two devices
    // can independently create "the same supplier" (identical name) with
    // different generated ids before ever syncing; name is the real
    // identity here (see utils/supplierLookup.js), so that's what dedupes.
    const supplierIdRemap = new Map(); // incoming id -> id actually stored locally, for remapping FK references below
    for (const s of suppliers) {
      const { rows } = await client.query(
        `INSERT INTO suppliers (id, store_id, name, contact_name, phone, email, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (store_id, name) DO UPDATE SET name = suppliers.name
         RETURNING id`,
        [s.id, storeId, s.name, s.contact_name, s.phone, s.email, s.notes, s.created_at]
      );
      if (rows[0] && rows[0].id !== s.id) supplierIdRemap.set(s.id, rows[0].id);
    }
    const resolveSupplierId = (id) => (id ? (supplierIdRemap.get(id) || id) : id);

    // Products next, before movements/arrivals/audits/etc. below — this
    // order is NOT arbitrary (an earlier version of this function claimed
    // it was, for the movements/arrivals/audits trio, which was true only
    // among themselves — not relative to products). Get this wrong and a
    // brand-new store's very first sync, where products and their
    // movements arrive in the SAME batch with nothing existing here yet,
    // throws a hard FK violation on the first movement — which, since
    // this all runs in one transaction, rolls back and 500s the ENTIRE
    // batch. Metadata (name/sku/price/location/etc.) is NOT event-sourced,
    // so it's merged last-write-wins by comparing updated_at. Quantities
    // are never taken from the remote row directly — they're recomputed
    // at the end from this database's own (now-merged) movement log,
    // since a third device's movements might already be here that the
    // remote side doesn't know about.
    for (const p of products) {
      const supplierId = resolveSupplierId(p.supplier_id);
      const existing = await client.query('SELECT id, updated_at FROM products WHERE id = $1', [p.id]);
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO products (id, store_id, name, sku, category, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level,
                  lead_time_days, min_order_qty, auto_reorder, archived_at, brand, image_url, storage_type, backroom_qty, shelf_qty, sold_qty, damaged_qty, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,0,0,0,0,$20,$21)
           ON CONFLICT (id) DO NOTHING`,
          [p.id, storeId, p.name, p.sku, p.category, p.supplier, supplierId, p.unit, p.location, p.cost_price, p.price_multiplier,
            p.reorder_level, p.lead_time_days, p.min_order_qty, p.auto_reorder, p.archived_at, p.brand, p.image_url, p.storage_type || 'ambient', p.created_at, p.updated_at]
        );
        touchedProductIds.add(p.id);
      } else if (new Date(p.updated_at) > new Date(existing.rows[0].updated_at)) {
        await client.query(
          `UPDATE products SET name=$1, sku=$2, category=$3, supplier=$4, supplier_id=$5, unit=$6, location=$7,
                  cost_price=$8, price_multiplier=$9, reorder_level=$10, lead_time_days=$11, min_order_qty=$12,
                  auto_reorder=$13, archived_at=$14, brand=$15, image_url=$16, storage_type=$17, updated_at=$18
           WHERE id=$19`,
          [p.name, p.sku, p.category, p.supplier, supplierId, p.unit, p.location, p.cost_price, p.price_multiplier,
            p.reorder_level, p.lead_time_days, p.min_order_qty, p.auto_reorder, p.archived_at, p.brand, p.image_url, p.storage_type || 'ambient', p.updated_at, p.id]
        );
        touchedProductIds.add(p.id);
      }
    }

    // Movements first among these three (arrivals/audits reference product
    // ids but movements are the actual quantity ledger — order among just
    // these three doesn't otherwise matter, they're independent tables).
    for (const m of movements) {
      await client.query(
        `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [m.id, storeId, m.product_id, m.type, m.quantity, m.note, resolveUser(m.performed_by), m.created_at]
      );
      touchedProductIds.add(m.product_id);
    }
    for (const a of arrivals) {
      await client.query(
        `INSERT INTO stock_arrivals (id, store_id, product_id, quantity, invoice_number, expiry_date, batch_number, receipt_id, received_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [a.id, storeId, a.product_id, a.quantity, a.invoice_number, a.expiry_date, a.batch_number, a.receipt_id, resolveUser(a.received_by), a.created_at]
      );
    }
    for (const au of audits) {
      await client.query(
        `INSERT INTO shelf_audits (id, store_id, product_id, counted_qty, expected_qty, discrepancy, confidence_source, auto_adjusted, performed_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [au.id, storeId, au.product_id, au.counted_qty, au.expected_qty, au.discrepancy, au.confidence_source, au.auto_adjusted, resolveUser(au.performed_by), au.created_at]
      );
    }

    // Purchase orders: append-only creation, but status/sent_at/expected_at/
    // received_at/received_by can each advance after creation — a rank
    // comparison stops an out-of-order sync from reverting an order that's
    // already progressed further locally than the incoming row shows.
    for (const po of purchaseOrders) {
      const supplierId = resolveSupplierId(po.supplier_id);
      const { rows: existingRows } = await client.query('SELECT status FROM purchase_orders WHERE id = $1', [po.id]);
      if (!existingRows[0]) {
        await client.query(
          `INSERT INTO purchase_orders
            (id, store_id, supplier, supplier_id, status, auto_generated, notes, total_cost, created_by, sent_at, expected_at, received_by, received_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [po.id, storeId, po.supplier, supplierId, po.status, po.auto_generated, po.notes, po.total_cost,
            resolveUser(po.created_by), po.sent_at, po.expected_at, resolveUser(po.received_by), po.received_at, po.created_at]
        );
      } else if ((PO_STATUS_RANK[po.status] ?? 0) > (PO_STATUS_RANK[existingRows[0].status] ?? 0)) {
        await client.query(
          `UPDATE purchase_orders SET status=$1, sent_at=$2, expected_at=$3, received_by=$4, received_at=$5 WHERE id=$6`,
          [po.status, po.sent_at, po.expected_at, resolveUser(po.received_by), po.received_at, po.id]
        );
      }
    }
    for (const item of purchaseOrderItems) {
      const { rows: existingRows } = await client.query('SELECT received_quantity FROM purchase_order_items WHERE id = $1', [item.id]);
      if (!existingRows[0]) {
        await client.query(
          `INSERT INTO purchase_order_items (id, purchase_order_id, product_id, quantity, unit_cost, received_quantity)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.id, item.purchase_order_id, item.product_id, item.quantity, item.unit_cost, item.received_quantity]
        );
      } else if (item.received_quantity > existingRows[0].received_quantity) {
        await client.query('UPDATE purchase_order_items SET received_quantity=$1 WHERE id=$2', [item.received_quantity, item.id]);
      }
    }

    // Batches are append-only (created once, at arrival time — see
    // migration 015's header), so a plain idempotent insert is enough.
    for (const b of batches) {
      await client.query(
        `INSERT INTO batches (id, store_id, product_id, batch_number, expiry_date, quantity_received, arrival_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [b.id, storeId, b.product_id, b.batch_number, b.expiry_date, b.quantity_received, b.arrival_id, b.created_at]
      );
    }

    // Append-only, same as shelf_audits — the stock adjustment (if any) is
    // a separate stock_movements row that syncs and recomputes
    // independently. task_id is always dropped here: cycle_count_tasks
    // (per-device scheduling suggestions) never sync to the cloud, so a
    // task_id from a device would never resolve — nulling it keeps the
    // actual count record (what matters for backup/reporting) intact
    // rather than losing the whole row to an unresolvable FK.
    for (const cc of cycleCounts) {
      await client.query(
        `INSERT INTO cycle_counts (id, store_id, product_id, task_id, counted_qty, expected_qty, discrepancy, auto_adjusted, performed_by, created_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [cc.id, storeId, cc.product_id, cc.counted_qty, cc.expected_qty, cc.discrepancy, cc.auto_adjusted, resolveUser(cc.performed_by), cc.created_at]
      );
    }

    // Receipts: status can advance pending -> applied/rejected.
    for (const r of receipts) {
      const { rows: existingRows } = await client.query('SELECT status FROM receipts WHERE id = $1', [r.id]);
      if (!existingRows[0]) {
        await client.query(
          `INSERT INTO receipts (id, store_id, image_url, raw_ocr_text, parsed_items, document_date, status, applied_at, uploaded_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [r.id, storeId, r.image_url, r.raw_ocr_text, JSON.stringify(r.parsed_items || []), r.document_date, r.status, r.applied_at, resolveUser(r.uploaded_by), r.created_at]
        );
      } else if ((RECEIPT_STATUS_RANK[r.status] ?? 0) > (RECEIPT_STATUS_RANK[existingRows[0].status] ?? 0)) {
        await client.query('UPDATE receipts SET status=$1, applied_at=$2 WHERE id=$3', [r.status, r.applied_at, r.id]);
      }
    }

    // Orders (POS): status can advance pending_payment -> paid/cancelled.
    for (const o of orders) {
      const { rows: existingRows } = await client.query('SELECT status FROM orders WHERE id = $1', [o.id]);
      if (!existingRows[0]) {
        await client.query(
          `INSERT INTO orders (id, store_id, status, subtotal, total, created_by, paid_by, payment_method, receipt_number, created_at, paid_at, cancelled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
          [o.id, storeId, o.status, o.subtotal, o.total, resolveUser(o.created_by), resolveUser(o.paid_by), o.payment_method, o.receipt_number, o.created_at, o.paid_at, o.cancelled_at]
        );
      } else if ((ORDER_STATUS_RANK[o.status] ?? 0) > (ORDER_STATUS_RANK[existingRows[0].status] ?? 0)) {
        await client.query(
          'UPDATE orders SET status=$1, paid_by=$2, payment_method=$3, receipt_number=$4, paid_at=$5, cancelled_at=$6 WHERE id=$7',
          [o.status, resolveUser(o.paid_by), o.payment_method, o.receipt_number, o.paid_at, o.cancelled_at, o.id]
        );
      }
    }
    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total, added_via, movement_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [item.id, item.order_id, item.product_id, item.quantity, item.unit_price, item.line_total, item.added_via, item.movement_id, item.created_at]
      );
    }

    // Webhooks: pure last-write-wins by updated_at, deleted_at included —
    // see migration 018's header for why a delete has to win outright
    // rather than being merged field-by-field.
    for (const w of webhooks) {
      const existing = await client.query('SELECT updated_at FROM webhooks WHERE id = $1', [w.id]);
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO webhooks (id, store_id, url, secret, events, active, last_triggered_at, last_status_code, created_by, created_at, updated_at, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
          [w.id, storeId, w.url, w.secret, w.events, w.active, w.last_triggered_at, w.last_status_code,
            resolveUser(w.created_by), w.created_at, w.updated_at, w.deleted_at]
        );
      } else if (new Date(w.updated_at) > new Date(existing.rows[0].updated_at)) {
        await client.query(
          `UPDATE webhooks SET url=$1, events=$2, active=$3, last_triggered_at=$4, last_status_code=$5, updated_at=$6, deleted_at=$7 WHERE id=$8`,
          [w.url, w.events, w.active, w.last_triggered_at, w.last_status_code, w.updated_at, w.deleted_at, w.id]
        );
      }
    }

    // Recompute every touched product's quantities from the fully-merged
    // local movement log — this is what makes the merge correct regardless
    // of how many devices contributed movements or in what order.
    for (const productId of touchedProductIds) {
      const stillExists = await client.query('SELECT id FROM products WHERE id = $1', [productId]);
      if (stillExists.rows[0]) await recomputeProductQuantities(client, productId);
    }

    await client.query('COMMIT');
    res.json({
      merged: {
        users: users.length,
        products: products.length, arrivals: arrivals.length, movements: movements.length, audits: audits.length,
        suppliers: suppliers.length, purchaseOrders: purchaseOrders.length, purchaseOrderItems: purchaseOrderItems.length,
        batches: batches.length, receipts: receipts.length, orders: orders.length, orderItems: orderItems.length,
        webhooks: webhooks.length, cycleCounts: cycleCounts.length,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to import sync batch' });
  } finally {
    client.release();
  }
}

module.exports = { exportChanges, importChanges };

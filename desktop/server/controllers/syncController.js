const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');

// See backend/src/controllers/syncController.js for the full rationale —
// this is the SQLite-flavored twin used by the desktop/LAN edition.
const PO_STATUS_RANK = { draft: 0, sent: 1, received: 2, cancelled: 2 };
const ORDER_STATUS_RANK = { pending_payment: 0, paid: 1, cancelled: 1 };
const RECEIPT_STATUS_RANK = { pending: 0, applied: 1, rejected: 1 };

// GET /api/stores/:storeId/sync/export?since=<ISO8601>
const parseJson = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
const asJson = (v, fallback) => JSON.stringify(v == null ? fallback : (typeof v === 'string' ? parseJson(v, fallback) : v));
const newer = (incoming, local) => !local || new Date(incoming) > new Date(local);
// Store settings that travel between devices and the cloud (latest edit wins).
const SETTINGS_COLS = 'name, currency_code, currency_symbol, timezone, tax_rate_pct, tax_inclusive, tax_label, tax_number, phone, address, city, receipt_header, receipt_footer, max_cashier_discount_pct, require_shift, points_per_100, point_value, points_expiry_months, daily_summary_enabled, business_type';
const SETTINGS_BOOLS = ['tax_inclusive', 'require_shift', 'daily_summary_enabled'];

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
  // updated_at also catches later changes such as the exit check.
  const orders = db.prepare('SELECT * FROM orders WHERE store_id = ? AND (created_at > ? OR paid_at > ? OR cancelled_at > ? OR updated_at > ?) ORDER BY created_at ASC').all(storeId, since, since, since, since);
  const orderItems = db.prepare(
    `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.store_id = ? AND (o.created_at > ? OR o.paid_at > ? OR o.cancelled_at > ? OR o.updated_at > ?)`
  ).all(storeId, since, since, since, since);
  // v26 till data: shifts, split payments, refunds.
  const shifts = db.prepare('SELECT * FROM shifts WHERE store_id = ? AND (opened_at > ? OR closed_at > ?) ORDER BY opened_at ASC').all(storeId, since, since);
  const orderPayments = db.prepare('SELECT * FROM order_payments WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const refunds = db.prepare('SELECT * FROM refunds WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const refundItems = db.prepare(
    'SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.store_id = ? AND r.created_at > ?'
  ).all(storeId, since);
  const customers = db.prepare('SELECT * FROM store_customers WHERE store_id = ? AND COALESCE(updated_at, created_at) > ? ORDER BY created_at ASC').all(storeId, since);
  const customerLedger = db.prepare('SELECT * FROM customer_ledger_entries WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const loyaltyPoints = db.prepare('SELECT * FROM loyalty_points WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  // updated_at, not created_at — a webhook edited (or soft-deleted) long
  // after creation still needs to show up in an incremental export.
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE store_id = ? AND updated_at > ? ORDER BY updated_at ASC').all(storeId, since);

  // Shop floor: handovers, returns at security, production, service jobs.
  // Records that change carry updated_at (latest wins); the rest never change.
  const handovers = db.prepare('SELECT * FROM stock_handovers WHERE store_id = ? AND COALESCE(updated_at, issued_at) > ? ORDER BY issued_at ASC').all(storeId, since);
  const handoverItems = handovers.length ? db.prepare(
    `SELECT i.* FROM stock_handover_items i JOIN stock_handovers h ON h.id = i.handover_id WHERE h.store_id = ? AND COALESCE(h.updated_at, h.issued_at) > ?`
  ).all(storeId, since) : [];
  const securityReturns = db.prepare('SELECT * FROM security_returns WHERE store_id = ? AND COALESCE(updated_at, created_at) > ? ORDER BY created_at ASC').all(storeId, since);
  const recipes = db.prepare('SELECT * FROM production_recipes WHERE store_id = ? AND COALESCE(updated_at, created_at) > ? ORDER BY created_at ASC').all(storeId, since)
    .map((r) => ({ ...r, active: !!r.active }));
  const recipeLines = recipes.length ? db.prepare(
    `SELECT l.* FROM production_recipe_lines l JOIN production_recipes r ON r.id = l.recipe_id WHERE r.store_id = ? AND COALESCE(r.updated_at, r.created_at) > ?`
  ).all(storeId, since) : [];
  const productionRuns = db.prepare('SELECT * FROM production_runs WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const productionRunLines = productionRuns.length ? db.prepare(
    'SELECT l.* FROM production_run_lines l JOIN production_runs r ON r.id = l.run_id WHERE r.store_id = ? AND r.created_at > ?'
  ).all(storeId, since) : [];
  const jobs = db.prepare('SELECT * FROM job_orders WHERE store_id = ? AND COALESCE(updated_at, created_at) > ? ORDER BY created_at ASC').all(storeId, since)
    .map((j) => ({ ...j, items: parseJson(j.items, []), measurements: parseJson(j.measurements, {}), item_details: parseJson(j.item_details, {}) }));
  const jobNotes = db.prepare('SELECT n.* FROM job_notes n JOIN job_orders j ON j.id = n.job_id WHERE j.store_id = ? AND n.created_at > ?').all(storeId, since);
  const productLooks = db.prepare('SELECT * FROM product_looks WHERE store_id = ? AND created_at > ? ORDER BY created_at ASC').all(storeId, since);
  const jobPayments = db.prepare('SELECT p.* FROM job_payments p JOIN job_orders j ON j.id = p.job_id WHERE j.store_id = ? AND p.created_at > ?').all(storeId, since);
  const jobMaterials = db.prepare('SELECT m.* FROM job_materials m JOIN job_orders j ON j.id = m.job_id WHERE j.store_id = ? AND m.created_at > ?').all(storeId, since);

  const settingsRow = db.prepare(`SELECT ${SETTINGS_COLS}, settings_updated_at FROM stores WHERE id = ? AND settings_updated_at > ?`).get(storeId, since);
  const storeSettings = settingsRow ? Object.fromEntries(Object.entries(settingsRow).map(([k, v]) => [k, SETTINGS_BOOLS.includes(k) ? !!v : v])) : null;

  res.json({
    serverTime: new Date().toISOString(),
    storeSettings,
    handovers, handoverItems, securityReturns, recipes, recipeLines, productionRuns, productionRunLines, jobs, jobPayments, jobMaterials, jobNotes, productLooks,
    users, products, arrivals, movements, audits,
    suppliers, purchaseOrders, purchaseOrderItems, batches, receipts, orders, orderItems, webhooks, cycleCounts,
    shifts, orderPayments, refunds, refundItems, customers, customerLedger, loyaltyPoints,
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
    customers = [], customerLedger = [], loyaltyPoints = [],
    handovers = [], handoverItems = [], securityReturns = [], recipes = [], recipeLines = [],
    productionRuns = [], productionRunLines = [], jobs = [], jobPayments = [], jobMaterials = [], jobNotes = [], productLooks = [], storeSettings = null,
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
    for (const p of products) {
      if (p.sold_by === undefined && p.shelf_life_days === undefined) continue;
      db.prepare('UPDATE products SET sold_by = ?, shelf_life_days = ? WHERE id = ? AND updated_at = ?')
        .run(['unit', 'weight', 'volume', 'length'].includes(p.sold_by) ? p.sold_by : 'unit', p.shelf_life_days || null, p.id, p.updated_at);
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

    // Store customers: last-write-wins on updated_at (falls back to created_at for never-edited rows).
    for (const c of customers) {
      const stamp = c.updated_at || c.created_at;
      const ex = db.prepare('SELECT COALESCE(updated_at, created_at) AS stamp FROM store_customers WHERE id = ?').get(c.id);
      const birthday = c.birthday ? new Date(c.birthday).toISOString().slice(0, 10) : null;
      if (!ex) {
        db.prepare(
          `INSERT OR IGNORE INTO store_customers (id, store_id, name, phone, notes, email, birthday, created_at, archived_at, updated_at, measurements)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(c.id, storeId, c.name, c.phone || null, c.notes || null, c.email || null, birthday, c.created_at, c.archived_at || null, stamp, asJson(c.measurements, {}));
      } else if (new Date(stamp) > new Date(ex.stamp)) {
        // One statement, setting updated_at itself, so the change-time trigger doesn't restamp it.
        db.prepare('UPDATE store_customers SET name=?, phone=?, notes=?, email=?, birthday=?, archived_at=?, measurements=COALESCE(?, measurements), updated_at=? WHERE id=?')
          .run(c.name, c.phone || null, c.notes || null, c.email || null, birthday, c.archived_at || null,
            c.measurements === undefined ? null : asJson(c.measurements, {}), stamp, c.id);
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
    // The exit check happens once per receipt; take it from whichever side did it.
    for (const o of orders) {
      if (!o.exit_checked_at) continue;
      db.prepare('UPDATE orders SET exit_checked_at = ?, exit_checked_by = ?, exit_status = ?, exit_note = ?, updated_at = COALESCE(?, updated_at) WHERE id = ? AND exit_checked_at IS NULL')
        .run(o.exit_checked_at, resolveUser(o.exit_checked_by), o.exit_status || 'passed', o.exit_note || null, o.updated_at || null, o.id);
    }
    for (const item of orderItems) {
      db.prepare(
        `INSERT OR IGNORE INTO order_items (id, order_id, product_id, quantity, unit_price, line_total, added_via, movement_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(item.id, item.order_id, item.product_id, item.quantity, item.unit_price, item.line_total, item.added_via, item.movement_id, item.created_at);
    }

    // Credit ledger and loyalty points are append-only; balances are sums over them.
    for (const e of customerLedger) {
      db.prepare(
        `INSERT OR IGNORE INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, order_id, note, recorded_by, created_at)
         SELECT ?,?,?,?,?,(SELECT id FROM orders WHERE id = ?),?,?,? WHERE EXISTS (SELECT 1 FROM store_customers WHERE id = ? AND store_id = ?)`
      ).run(e.id, storeId, e.store_customer_id, e.type, Number(e.amount), e.order_id || null, e.note || null, resolveUser(e.recorded_by), e.created_at, e.store_customer_id, storeId);
    }
    for (const lp of loyaltyPoints) {
      db.prepare(
        `INSERT OR IGNORE INTO loyalty_points (id, store_id, store_customer_id, points, order_id, reason, expires_at, created_at)
         SELECT ?,?,?,?,(SELECT id FROM orders WHERE id = ?),?,?,? WHERE EXISTS (SELECT 1 FROM store_customers WHERE id = ? AND store_id = ?)`
      ).run(lp.id, storeId, lp.store_customer_id, lp.points, lp.order_id || null, lp.reason || 'sale', lp.expires_at || null, lp.created_at, lp.store_customer_id, storeId);
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

    if (storeSettings?.settings_updated_at) {
      const local = db.prepare('SELECT settings_updated_at FROM stores WHERE id = ?').get(storeId);
      if (local && newer(storeSettings.settings_updated_at, local.settings_updated_at)) {
        const cols = SETTINGS_COLS.split(', ').filter((c) => storeSettings[c] !== undefined && !(c === 'name' && !storeSettings.name));
        db.prepare(`UPDATE stores SET ${cols.map((c) => `${c} = ?`).join(', ')}, settings_updated_at = ? WHERE id = ?`)
          .run(...cols.map((c) => (SETTINGS_BOOLS.includes(c) ? (storeSettings[c] ? 1 : 0) : storeSettings[c])), storeSettings.settings_updated_at, storeId);
      }
    }
    importShopFloor({ storeId, resolveUser, handovers, handoverItems, securityReturns, recipes, recipeLines, productionRuns, productionRunLines, jobs, jobPayments, jobMaterials, jobNotes, productLooks });

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
        customers: customers.length, customerLedger: customerLedger.length, loyaltyPoints: loyaltyPoints.length,
        handovers: handovers.length, securityReturns: securityReturns.length, recipes: recipes.length,
        productionRuns: productionRuns.length, jobs: jobs.length, jobPayments: jobPayments.length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import sync batch' });
  }
}

// A tag code is unique per shop; if two offline devices ever picked the same
// one, the newcomer keeps a suffixed tag (its printed tag still finds it by ref).
function freeTag(tag, id) {
  if (!tag) return null;
  const taken = db.prepare('SELECT id FROM job_orders WHERE tag_code = ?').get(tag);
  return taken && taken.id !== id ? `${tag}${String(id).replace(/-/g, '').slice(0, 2).toUpperCase()}`.slice(0, 12) : tag;
}

// Handovers, returns at security, production and service jobs. Stock itself
// moves through stock_movements (synced above), so these are the records.
function importShopFloor(x) {
  const { storeId, resolveUser } = x;
  const has = (table, id) => !!(id && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

  for (const h of x.handovers) {
    const ex = db.prepare('SELECT updated_at FROM stock_handovers WHERE id = ?').get(h.id);
    const stamp = h.updated_at || h.received_at || h.issued_at;
    if (!ex) {
      db.prepare(`INSERT OR IGNORE INTO stock_handovers (id, store_id, status, note, issued_by, issued_at, received_by, received_at, receive_note, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(h.id, storeId, h.status, h.note || null, resolveUser(h.issued_by), h.issued_at, resolveUser(h.received_by), h.received_at || null, h.receive_note || null, stamp);
    } else if (newer(stamp, ex.updated_at)) {
      db.prepare('UPDATE stock_handovers SET status=?, note=?, received_by=?, received_at=?, receive_note=?, updated_at=? WHERE id=?')
        .run(h.status, h.note || null, resolveUser(h.received_by), h.received_at || null, h.receive_note || null, stamp, h.id);
    }
  }
  for (const i of x.handoverItems) {
    if (!has('stock_handovers', i.handover_id) || !has('products', i.product_id)) continue;
    db.prepare('INSERT OR IGNORE INTO stock_handover_items (id, handover_id, product_id, qty_issued, qty_received) VALUES (?,?,?,?,?)')
      .run(i.id, i.handover_id, i.product_id, Number(i.qty_issued), i.qty_received == null ? null : Number(i.qty_received));
    if (i.qty_received != null) db.prepare('UPDATE stock_handover_items SET qty_received = ? WHERE id = ? AND qty_received IS NULL').run(Number(i.qty_received), i.id);
  }

  for (const r of x.securityReturns) {
    if (!has('orders', r.order_id) || !has('order_items', r.order_item_id)) continue;
    const ex = db.prepare('SELECT updated_at FROM security_returns WHERE id = ?').get(r.id);
    const stamp = r.updated_at || r.received_at || r.created_at;
    if (!ex) {
      db.prepare(`INSERT OR IGNORE INTO security_returns (id, store_id, order_id, order_item_id, quantity, note, checked_by, received_by, received_at, qty_resellable, qty_damaged, receive_note, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, storeId, r.order_id, r.order_item_id, Number(r.quantity), r.note || null, resolveUser(r.checked_by),
        resolveUser(r.received_by), r.received_at || null, r.qty_resellable == null ? null : Number(r.qty_resellable), r.qty_damaged == null ? null : Number(r.qty_damaged), r.receive_note || null, r.created_at, stamp);
    } else if (newer(stamp, ex.updated_at)) {
      db.prepare('UPDATE security_returns SET received_by=?, received_at=?, qty_resellable=?, qty_damaged=?, receive_note=?, updated_at=? WHERE id=?')
        .run(resolveUser(r.received_by), r.received_at || null, r.qty_resellable == null ? null : Number(r.qty_resellable), r.qty_damaged == null ? null : Number(r.qty_damaged), r.receive_note || null, stamp, r.id);
    }
  }

  for (const r of x.recipes) {
    const ex = db.prepare('SELECT updated_at FROM production_recipes WHERE id = ?').get(r.id);
    const stamp = r.updated_at || r.created_at;
    const active = r.active === false || Number(r.active) === 0 ? 0 : 1;
    if (!ex) {
      db.prepare('INSERT OR IGNORE INTO production_recipes (id, store_id, name, kind, notes, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(r.id, storeId, r.name, r.kind, r.notes || null, active, r.created_at, stamp);
    } else if (newer(stamp, ex.updated_at)) {
      db.prepare('UPDATE production_recipes SET name=?, notes=?, active=?, updated_at=? WHERE id=?').run(r.name, r.notes || null, active, stamp, r.id);
    }
  }
  for (const l of x.recipeLines) {
    if (!has('production_recipes', l.recipe_id) || !has('products', l.product_id)) continue;
    db.prepare('INSERT OR IGNORE INTO production_recipe_lines (id, recipe_id, product_id, role, quantity) VALUES (?,?,?,?,?)').run(l.id, l.recipe_id, l.product_id, l.role, Number(l.quantity));
  }
  for (const r of x.productionRuns) {
    db.prepare(`INSERT OR IGNORE INTO production_runs (id, store_id, recipe_id, kind, batches, note, input_cost, performed_by, created_at)
      VALUES (?,?,(SELECT id FROM production_recipes WHERE id = ?),?,?,?,?,?,?)`).run(r.id, storeId, r.recipe_id || null, r.kind, Number(r.batches), r.note || null, Number(r.input_cost || 0), resolveUser(r.performed_by), r.created_at);
  }
  for (const l of x.productionRunLines) {
    if (!has('production_runs', l.run_id) || !has('products', l.product_id)) continue;
    db.prepare('INSERT OR IGNORE INTO production_run_lines (id, run_id, product_id, role, expected_qty, quantity) VALUES (?,?,?,?,?,?)')
      .run(l.id, l.run_id, l.product_id, l.role, Number(l.expected_qty || 0), Number(l.quantity));
  }

  for (const j of x.jobs) {
    const ex = db.prepare('SELECT updated_at FROM job_orders WHERE id = ?').get(j.id);
    const stamp = j.updated_at || j.collected_at || j.created_at;
    const cust = has('store_customers', j.store_customer_id) ? j.store_customer_id : null;
    const due = j.due_date ? String(j.due_date).slice(0, 10) : null;
    if (!ex) {
      // Two offline devices can, rarely, pick the same job reference: keep both jobs, suffixing the newcomer's.
      const clash = !!db.prepare('SELECT 1 FROM job_orders WHERE store_id = ? AND ref = ?').get(storeId, j.ref);
      const ref = clash ? `${j.ref}-${String(j.id).replace(/-/g, '').slice(0, 3).toUpperCase()}` : j.ref;
      db.prepare(`INSERT OR IGNORE INTO job_orders (id, store_id, ref, store_customer_id, customer_name, customer_phone, title, items, measurements, total, paid, status, due_date, notes, assigned_to, created_by, created_at, updated_at, collected_at,
                                                    item_details, fault, condition_notes, accessories, diagnosis, tag_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(j.id, storeId, ref, cust, j.customer_name, j.customer_phone || null, j.title, asJson(j.items, []), asJson(j.measurements, {}),
        Number(j.total), Number(j.paid), j.status, due, j.notes || null, resolveUser(j.assigned_to), resolveUser(j.created_by), j.created_at, stamp, j.collected_at || null,
        asJson(j.item_details, {}), j.fault || null, j.condition_notes || null, j.accessories || null, j.diagnosis || null, freeTag(j.tag_code, j.id));
    } else if (newer(stamp, ex.updated_at)) {
      db.prepare(`UPDATE job_orders SET title=?, items=?, measurements=?, total=?, paid=?, status=?, due_date=?, notes=?, assigned_to=?, collected_at=?,
                  item_details=?, fault=?, condition_notes=?, accessories=?, diagnosis=?, updated_at=? WHERE id=?`)
        .run(j.title, asJson(j.items, []), asJson(j.measurements, {}), Number(j.total), Number(j.paid), j.status, due, j.notes || null, resolveUser(j.assigned_to), j.collected_at || null,
          asJson(j.item_details, {}), j.fault || null, j.condition_notes || null, j.accessories || null, j.diagnosis || null, stamp, j.id);
    }
  }
  for (const p of x.jobPayments) {
    if (!has('job_orders', p.job_id)) continue;
    db.prepare(`INSERT OR IGNORE INTO job_payments (id, job_id, amount, method, kind, recorded_by, shift_id, created_at)
      VALUES (?,?,?,?,?,?,(SELECT id FROM shifts WHERE id = ?),?)`).run(p.id, p.job_id, Number(p.amount), p.method, p.kind, resolveUser(p.recorded_by), p.shift_id || null, p.created_at);
  }
  for (const n of x.jobNotes || []) {
    if (!has('job_orders', n.job_id)) continue;
    db.prepare('INSERT OR IGNORE INTO job_notes (id, job_id, note, created_by, created_at) VALUES (?,?,?,?,?)').run(n.id, n.job_id, n.note, resolveUser(n.created_by), n.created_at);
  }
  for (const m of x.jobMaterials) {
    if (!has('job_orders', m.job_id) || !has('products', m.product_id)) continue;
    db.prepare('INSERT OR IGNORE INTO job_materials (id, job_id, product_id, quantity, recorded_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(m.id, m.job_id, m.product_id, Number(m.quantity), resolveUser(m.recorded_by), m.created_at);
  }
  for (const l of x.productLooks || []) {
    if (typeof l.sig !== 'string' || l.sig.length > 800 || !has('products', l.product_id)) continue;
    db.prepare('INSERT OR IGNORE INTO product_looks (id, store_id, product_id, sig, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(l.id, x.storeId, l.product_id, l.sig, resolveUser(l.created_by), l.created_at);
  }
}

module.exports = { exportChanges, importChanges };

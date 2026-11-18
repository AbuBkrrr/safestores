const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { emitToStore } = require('../realtime');

// ------------------------------------------------------------
// Stock Arrivals
// ------------------------------------------------------------

function listArrivals(req, res) {
  const { storeId } = req.params;
  res.json(db.prepare(
    `SELECT sa.*, p.name AS product_name, p.sku FROM stock_arrivals sa
     JOIN products p ON p.id = sa.product_id
     WHERE sa.store_id = ? ORDER BY sa.created_at DESC`
  ).all(storeId));
}

// body: { id?, movementId?, productId, quantity, invoiceNumber, expiryDate, batchNumber }
// `id`/`movementId` are optional client-generated UUIDs so an action
// recorded offline (or synced from another device) can be replayed safely —
// INSERT OR IGNORE makes re-applying the same id a no-op instead of a
// duplicate/double-count.
function createArrival(req, res) {
  const { storeId } = req.params;
  const { id, movementId, productId, quantity, invoiceNumber, expiryDate, batchNumber } = req.body;
  if (!productId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }

  const arrivalId = id || crypto.randomUUID();
  const existing = db.prepare('SELECT * FROM stock_arrivals WHERE id = ?').get(arrivalId);
  if (existing) return res.status(201).json(existing); // already applied — safe no-op

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_arrivals (id, store_id, product_id, quantity, invoice_number, expiry_date, batch_number, received_by)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(arrivalId, storeId, productId, quantity, invoiceNumber || null, expiryDate || null, batchNumber || null, req.user.sub);

    db.prepare(
      `INSERT OR IGNORE INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
       VALUES (?,?,?,'arrival',?,?,?)`
    ).run(movementId || crypto.randomUUID(), storeId, productId, quantity, `Invoice ${invoiceNumber || 'N/A'}`, req.user.sub);

    // Expiry & Batch Tracking: only arrivals with an expiry date create a
    // trackable batch. The UNIQUE(arrival_id) constraint is the second
    // line of defense against a replayed offline request double-creating one.
    if (expiryDate) {
      db.prepare(
        `INSERT OR IGNORE INTO batches (id, store_id, product_id, batch_number, expiry_date, quantity_received, arrival_id)
         VALUES (?,?,?,?,?,?,?)`
      ).run(crypto.randomUUID(), storeId, productId, batchNumber || null, expiryDate, quantity, arrivalId);
    }

    recomputeProductQuantities(db, productId);
  })();

  res.status(201).json(db.prepare('SELECT * FROM stock_arrivals WHERE id = ?').get(arrivalId));
  try {
    emitToStore(storeId, 'arrival:created', db.prepare('SELECT * FROM stock_arrivals WHERE id = ?').get(arrivalId));
    emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
  } catch (sideEffectErr) {
    console.error('createArrival: post-response realtime side effect failed:', sideEffectErr);
  }
}

// ------------------------------------------------------------
// Stock Movements
// ------------------------------------------------------------

function listMovements(req, res) {
  const { storeId } = req.params;
  res.json(db.prepare(
    `SELECT sm.*, p.name AS product_name, p.sku FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     WHERE sm.store_id = ? ORDER BY sm.created_at DESC LIMIT 500`
  ).all(storeId));
}

function createMovement(req, res) {
  const { storeId } = req.params;
  const { id, productId, type, quantity, note } = req.body;
  const validTypes = ['transfer_to_shelf', 'sale', 'damage', 'expiry', 'adjustment'];
  if (!productId || !validTypes.includes(type) || quantity === undefined) {
    return res.status(400).json({ error: `type must be one of ${validTypes.join(', ')}` });
  }

  if (id) {
    const existing = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(id);
    if (existing) return res.status(201).json(existing); // already applied — safe no-op
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Helpful early error for the common single-device case; the movement
  // insert + recompute below is still the authoritative check.
  if (type === 'transfer_to_shelf' && product.backroom_qty < quantity) {
    return res.status(400).json({ error: 'Not enough backroom stock for this transfer' });
  } else if (type === 'sale' && product.shelf_qty < quantity) {
    return res.status(400).json({ error: 'Not enough shelf stock for this sale' });
  } else if ((type === 'damage' || type === 'expiry') && product.shelf_qty < quantity) {
    return res.status(400).json({ error: 'Not enough shelf stock to record as damaged/expired' });
  } else if (type === 'adjustment' && product.shelf_qty + quantity < 0) {
    return res.status(400).json({ error: 'Adjustment would result in negative shelf stock' });
  }

  const moveId = id || crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
       VALUES (?,?,?,?,?,?,?)`
    ).run(moveId, storeId, productId, type, quantity, note || null, req.user.sub);

    recomputeProductQuantities(db, productId);
  })();

  res.status(201).json(db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(moveId));
  try {
    emitToStore(storeId, 'movement:created', db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(moveId));
    emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
  } catch (sideEffectErr) {
    console.error('createMovement: post-response realtime side effect failed:', sideEffectErr);
  }
}

// ------------------------------------------------------------
// Shelf Audits
// ------------------------------------------------------------

function listAudits(req, res) {
  const { storeId } = req.params;
  const { area } = req.query;
  const rows = area
    ? db.prepare(
        `SELECT sa.*, p.name AS product_name, p.sku, p.location, u.name AS performed_by_name
         FROM shelf_audits sa
         JOIN products p ON p.id = sa.product_id
         LEFT JOIN users u ON u.id = sa.performed_by
         WHERE sa.store_id = ? AND sa.area = ? ORDER BY sa.created_at DESC`
      ).all(storeId, area)
    : db.prepare(
        `SELECT sa.*, p.name AS product_name, p.sku, p.location, u.name AS performed_by_name
         FROM shelf_audits sa
         JOIN products p ON p.id = sa.product_id
         LEFT JOIN users u ON u.id = sa.performed_by
         WHERE sa.store_id = ? ORDER BY sa.created_at DESC`
      ).all(storeId);
  res.json(rows);
}

// body: { id?, adjustmentMovementId?, productId, countedQty, confidenceSource?, autoAdjust?,
//         area? ('shelf'|'backroom'|'warehouse'), floorNumber?, shelfNumber?, rowNumber?, zone? }
// A manual, physical count at a specific location. 'shelf' reconciles
// against products.shelf_qty (front-of-store); 'backroom'/'warehouse'
// reconcile against products.backroom_qty instead — auto-adjusting either
// writes a distinct movement type so the event log stays an accurate
// record of *which* stock pool actually changed.
// How recent a prior count at the same location has to be to count as a
// live disagreement worth flagging, rather than just "the count changed
// since this was last audited weeks ago" (which is normal and expected).
const CONFLICT_WINDOW_HOURS = 48;

function notifyStore(storeId, { type, severity, audienceRole, userId, conflictGroupId, message }) {
  db.prepare(
    `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, user_id, conflict_group_id, message)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(crypto.randomUUID(), storeId, type, severity || 'amber', audienceRole || null, userId || null, conflictGroupId || null, message);
}

function createAudit(req, res) {
  const { storeId } = req.params;
  const {
    id, adjustmentMovementId, productId, countedQty, confidenceSource, autoAdjust,
    area, floorNumber, shelfNumber, rowNumber, zone, conflictGroupId,
  } = req.body;
  if (!productId || countedQty === undefined) return res.status(400).json({ error: 'productId and countedQty are required' });
  const auditArea = ['shelf', 'backroom', 'warehouse'].includes(area) ? area : 'shelf';

  if (id) {
    const existing = db.prepare('SELECT * FROM shelf_audits WHERE id = ?').get(id);
    if (existing) return res.status(201).json(existing); // already applied — safe no-op
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const expected = auditArea === 'shelf' ? product.shelf_qty : product.backroom_qty;
  const discrepancy = countedQty - expected;
  const auditId = id || crypto.randomUUID();

  const result = db.transaction(() => {
    // A recount explicitly attaches to an existing conflict — a normal
    // fresh count instead checks whether it disagrees with a recent count
    // by a DIFFERENT stocktaker at the exact same location.
    let groupId = conflictGroupId || null;
    let flagged = !!conflictGroupId;

    if (!conflictGroupId) {
      const priorConflict = db.prepare(
        `SELECT * FROM shelf_audits
         WHERE store_id = ? AND product_id = ? AND area = ?
           AND COALESCE(floor_number,'') = COALESCE(?,'') AND COALESCE(shelf_number,'') = COALESCE(?,'')
           AND COALESCE(row_number,'') = COALESCE(?,'') AND COALESCE(zone,'') = COALESCE(?,'')
           AND performed_by IS NOT NULL AND performed_by != ?
           AND counted_qty != ?
           AND status != 'resolved'
           AND created_at >= datetime('now', '-${CONFLICT_WINDOW_HOURS} hours')
         ORDER BY created_at DESC LIMIT 1`
      ).get(storeId, productId, auditArea, floorNumber || null, shelfNumber || null, rowNumber || null, zone || null, req.user.sub, countedQty);

      if (priorConflict) {
        groupId = priorConflict.conflict_group_id || crypto.randomUUID();
        flagged = true;
        db.prepare(`UPDATE shelf_audits SET status = 'needs_recount', conflict_group_id = ? WHERE id = ?`).run(groupId, priorConflict.id);
      }
    }

    db.prepare(
      `INSERT INTO shelf_audits
         (id, store_id, product_id, counted_qty, expected_qty, discrepancy, confidence_source, auto_adjusted,
          area, floor_number, shelf_number, row_number, zone, status, conflict_group_id, performed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      auditId, storeId, productId, countedQty, expected, discrepancy, confidenceSource || 'manual_count', autoAdjust ? 1 : 0,
      auditArea, floorNumber || null, shelfNumber || null, rowNumber || null, zone || null,
      flagged ? 'needs_recount' : 'confirmed', groupId, req.user.sub
    );

    if (flagged) {
      const locationLabel = [floorNumber && `Floor ${floorNumber}`, shelfNumber && `Shelf ${shelfNumber}`, rowNumber && `Row ${rowNumber}`, zone]
        .filter(Boolean).join(', ') || auditArea;
      const message = `Recount needed: ${product.name} at ${locationLabel} — counts disagree (latest: ${countedQty}).`;
      notifyStore(storeId, { type: 'recount_needed', severity: 'amber', audienceRole: 'admin', conflictGroupId: groupId, message });
      // Notify every distinct stocktaker who has counted this location as
      // part of the conflict so far, so both/all of them see the amber
      // alert, not just whoever triggered this particular submission.
      const performers = db.prepare(
        `SELECT DISTINCT performed_by FROM shelf_audits WHERE conflict_group_id = ? AND performed_by IS NOT NULL`
      ).all(groupId);
      for (const p of performers) {
        notifyStore(storeId, { type: 'recount_needed', severity: 'amber', userId: p.performed_by, conflictGroupId: groupId, message });
      }
    }

    if (autoAdjust && discrepancy !== 0 && !flagged) {
      const movementType = auditArea === 'shelf' ? 'adjustment' : 'backroom_adjustment';
      db.prepare(
        `INSERT OR IGNORE INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
         VALUES (?,?,?,?,?, ?, ?)`
      ).run(adjustmentMovementId || crypto.randomUUID(), storeId, productId, movementType, discrepancy, `Auto-adjusted from ${auditArea} audit`, req.user.sub);
      recomputeProductQuantities(db, productId);
    }

    return flagged;
  })();

  res.status(201).json({ ...db.prepare('SELECT * FROM shelf_audits WHERE id = ?').get(auditId), flaggedForRecount: result });

  try {
    const auditRow = db.prepare(
      `SELECT sa.*, p.name AS product_name FROM shelf_audits sa JOIN products p ON p.id = sa.product_id WHERE sa.id = ?`
    ).get(auditId);
    emitToStore(storeId, 'audit:created', auditRow);
    emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
  } catch (sideEffectErr) {
    console.error('createAudit: post-response realtime side effect failed:', sideEffectErr);
  }
}

// GET /stores/:storeId/audits/conflicts?mine=true
// Open recount conflicts. Admins see everything; a stocktaker passing
// ?mine=true sees only conflicts they're personally party to.
function listConflicts(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT sa.conflict_group_id, p.id AS product_id, p.name AS product_name, sa.area,
            sa.floor_number, sa.shelf_number, sa.row_number, sa.zone,
            json_group_array(json_object(
              'id', sa.id, 'countedQty', sa.counted_qty, 'performedBy', sa.performed_by,
              'performedByName', u.name, 'createdAt', sa.created_at
            )) AS entries_json
     FROM shelf_audits sa
     JOIN products p ON p.id = sa.product_id
     LEFT JOIN users u ON u.id = sa.performed_by
     WHERE sa.store_id = ? AND sa.status = 'needs_recount' AND sa.conflict_group_id IS NOT NULL
     GROUP BY sa.conflict_group_id
     ORDER BY MAX(sa.created_at) DESC`
  ).all(storeId);

  const conflicts = rows.map((r) => {
    const entries = JSON.parse(r.entries_json);
    const acceptances = db.prepare(
      `SELECT user_id FROM audit_conflict_acceptances WHERE conflict_group_id = ?`
    ).all(r.conflict_group_id).map((a) => a.user_id);
    return { ...r, entries_json: undefined, entries, acceptances };
  });

  const mine = req.query.mine === 'true';
  const filtered = mine
    ? conflicts.filter((c) => c.entries.some((e) => e.performedBy === req.user.sub))
    : conflicts;

  res.json(filtered);
}

// POST /stores/:storeId/audits/conflicts/:groupId/accept
// The counterpart stocktaker(s) confirm the latest recount figure is
// correct. Once every distinct original performer (other than whoever
// submitted the latest count in the group) has accepted, the whole group
// resolves and the admin gets notified it's settled.
function acceptRecount(req, res) {
  const { storeId, groupId } = req.params;
  const audits = db.prepare(
    `SELECT * FROM shelf_audits WHERE store_id = ? AND conflict_group_id = ? ORDER BY created_at ASC`
  ).all(storeId, groupId);
  if (audits.length === 0) return res.status(404).json({ error: 'Conflict not found' });

  const latest = audits[audits.length - 1];
  if (latest.performed_by === req.user.sub) {
    return res.status(400).json({ error: "You submitted the latest count — the other stocktaker(s) need to accept it, not you" });
  }

  db.prepare(
    `INSERT OR IGNORE INTO audit_conflict_acceptances (id, conflict_group_id, user_id) VALUES (?,?,?)`
  ).run(crypto.randomUUID(), groupId, req.user.sub);

  const distinctPerformers = [...new Set(audits.map((a) => a.performed_by).filter((p) => p && p !== latest.performed_by))];
  const acceptedBy = db.prepare(`SELECT user_id FROM audit_conflict_acceptances WHERE conflict_group_id = ?`).all(groupId).map((a) => a.user_id);
  const allAccepted = distinctPerformers.every((p) => acceptedBy.includes(p));

  if (allAccepted) {
    db.prepare(
      `UPDATE shelf_audits SET status = 'resolved', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conflict_group_id = ?`
    ).run(req.user.sub, groupId);

    const product = db.prepare('SELECT name FROM products WHERE id = ?').get(latest.product_id);
    notifyStore(storeId, {
      type: 'recount_resolved', severity: 'info', audienceRole: 'admin',
      conflictGroupId: groupId,
      message: `Recount resolved for ${product.name} — confirmed count: ${latest.counted_qty}.`,
    });

    // The confirmed figure is now authoritative — apply it the same way a
    // normal auto-adjusted audit would, if it wasn't already.
    const productRow = db.prepare('SELECT * FROM products WHERE id = ?').get(latest.product_id);
    const currentExpected = latest.area === 'shelf' ? productRow.shelf_qty : productRow.backroom_qty;
    const finalDiscrepancy = latest.counted_qty - currentExpected;
    if (finalDiscrepancy !== 0) {
      const movementType = latest.area === 'shelf' ? 'adjustment' : 'backroom_adjustment';
      db.prepare(
        `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
         VALUES (?,?,?,?,?,?,?)`
      ).run(crypto.randomUUID(), storeId, latest.product_id, movementType, finalDiscrepancy, 'Applied after recount resolution', req.user.sub);
      recomputeProductQuantities(db, latest.product_id);
    }
  }

  res.json({ resolved: allAccepted });
}

// GET /api/stores/:storeId/audits/report?from=&to=&productId=
//
// A comprehensive, per-product reconciliation: for every product (or one,
// if productId is given), how much arrived and when, how much sold/was
// damaged in the window, what the system currently expects on the shelf
// and in the backroom/warehouse, and what the most recent physical count
// at each location actually found — with that count's floor/shelf/row (or
// warehouse zone), so a discrepancy can be traced back to where it was
// found. Defaults the window to "since this product's first-ever arrival"
// when no `from` is given, which is what makes this "based on time of
// arrival of goods to date" rather than an arbitrary recent slice.
function auditReport(req, res) {
  const { storeId } = req.params;
  const { from, to, productId } = req.query;
  const toDate = to || new Date().toISOString();

  const products = productId
    ? db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').all(productId, storeId)
    : db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY name ASC').all(storeId);

  const report = products.map((product) => {
    const firstArrival = db.prepare(
      `SELECT MIN(created_at) AS d FROM stock_arrivals WHERE product_id = ?`
    ).get(product.id).d;
    const fromDate = from || firstArrival || product.created_at;

    const activity = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'arrival' THEN quantity ELSE 0 END), 0) AS received_qty,
         COALESCE(SUM(CASE WHEN type = 'sale' THEN quantity ELSE 0 END), 0) AS sold_qty,
         COALESCE(SUM(CASE WHEN type IN ('damage','expiry') THEN quantity ELSE 0 END), 0) AS damaged_qty,
         COALESCE(SUM(CASE WHEN type = 'transfer_to_shelf' THEN quantity ELSE 0 END), 0) AS transferred_to_shelf_qty
       FROM stock_movements
       WHERE product_id = ? AND created_at BETWEEN ? AND ?`
    ).get(product.id, fromDate, toDate);
    // stock_arrivals themselves also feed the 'arrival' movement type, but
    // querying stock_arrivals directly too covers invoice-numbered detail.
    const arrivals = db.prepare(
      `SELECT id, quantity, invoice_number, expiry_date, created_at FROM stock_arrivals
       WHERE product_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at ASC`
    ).all(product.id, fromDate, toDate);

    const latestShelfAudit = db.prepare(
      `SELECT sa.*, u.name AS performed_by_name FROM shelf_audits sa LEFT JOIN users u ON u.id = sa.performed_by
       WHERE sa.product_id = ? AND sa.area = 'shelf' AND sa.created_at BETWEEN ? AND ?
       ORDER BY sa.created_at DESC LIMIT 1`
    ).get(product.id, fromDate, toDate);
    const latestBackroomAudit = db.prepare(
      `SELECT sa.*, u.name AS performed_by_name FROM shelf_audits sa LEFT JOIN users u ON u.id = sa.performed_by
       WHERE sa.product_id = ? AND sa.area IN ('backroom','warehouse') AND sa.created_at BETWEEN ? AND ?
       ORDER BY sa.created_at DESC LIMIT 1`
    ).get(product.id, fromDate, toDate);

    const systemTotalQty = product.shelf_qty + product.backroom_qty;
    const countedTotalQty = (latestShelfAudit ? latestShelfAudit.counted_qty : product.shelf_qty)
      + (latestBackroomAudit ? latestBackroomAudit.counted_qty : product.backroom_qty);

    return {
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      location: product.location,
      periodFrom: fromDate,
      periodTo: toDate,
      firstArrivalDate: firstArrival,
      receivedQty: activity.received_qty,
      soldQty: activity.sold_qty,
      damagedQty: activity.damaged_qty,
      transferredToShelfQty: activity.transferred_to_shelf_qty,
      arrivals,
      systemShelfQty: product.shelf_qty,
      systemBackroomQty: product.backroom_qty,
      systemTotalQty,
      shelfAudit: latestShelfAudit || null,
      backroomAudit: latestBackroomAudit || null,
      countedTotalQty: (latestShelfAudit || latestBackroomAudit) ? countedTotalQty : null,
      totalDiscrepancy: (latestShelfAudit || latestBackroomAudit) ? countedTotalQty - systemTotalQty : null,
    };
  });

  res.json(report);
}

module.exports = {
  listArrivals, createArrival,
  listMovements, createMovement,
  listAudits, createAudit, auditReport,
  listConflicts, acceptRecount,
};

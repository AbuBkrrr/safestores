// ------------------------------------------------------------
// Stock Arrivals, Stock Movements, and Shelf Audits (incl. the
// multi-stocktaker recount/conflict workflow) for the standalone web
// edition. Postgres-flavored twin of
// desktop/server/controllers/inventoryController.js — same behavior,
// async/await + $N params instead of better-sqlite3's synchronous API.
// ------------------------------------------------------------

const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { emitToStore } = require('../realtime');
const { sendPushToStore } = require('../utils/push');

// ------------------------------------------------------------
// Stock Arrivals
// ------------------------------------------------------------

// GET /api/stores/:storeId/arrivals
async function listArrivals(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT sa.*, p.name AS product_name, p.sku FROM stock_arrivals sa
     JOIN products p ON p.id = sa.product_id
     WHERE sa.store_id = $1 ORDER BY sa.created_at DESC`,
    [storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/arrivals
// body: { id?, movementId?, productId, quantity, invoiceNumber, expiryDate, batchNumber }
// `id`/`movementId` are optional client-generated UUIDs so an action
// recorded offline (or synced from another device) can be replayed safely.
async function createArrival(req, res) {
  const { storeId } = req.params;
  const { id, movementId, productId, quantity, invoiceNumber, expiryDate, batchNumber } = req.body;
  if (!productId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'productId and a positive quantity are required' });
  }

  if (id) {
    const { rows: existing } = await db.query('SELECT * FROM stock_arrivals WHERE id = $1', [id]);
    if (existing[0]) return res.status(201).json(existing[0]); // already applied — safe no-op
  }

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  if (!productRows[0]) return res.status(404).json({ error: 'Product not found' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const arrivalCols = id
      ? '(id, store_id, product_id, quantity, invoice_number, expiry_date, batch_number, received_by)'
      : '(store_id, product_id, quantity, invoice_number, expiry_date, batch_number, received_by)';
    const arrivalValues = id
      ? [id, storeId, productId, quantity, invoiceNumber || null, expiryDate || null, batchNumber || null, req.user.sub]
      : [storeId, productId, quantity, invoiceNumber || null, expiryDate || null, batchNumber || null, req.user.sub];
    const arrivalPlaceholders = arrivalValues.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: arrivalRows } = await client.query(
      `INSERT INTO stock_arrivals ${arrivalCols} VALUES (${arrivalPlaceholders}) RETURNING *`,
      arrivalValues
    );
    const arrival = arrivalRows[0];

    const moveCols = movementId
      ? '(id, store_id, product_id, type, quantity, note, performed_by)'
      : '(store_id, product_id, type, quantity, note, performed_by)';
    const moveValues = movementId
      ? [movementId, storeId, productId, 'arrival', quantity, `Invoice ${invoiceNumber || 'N/A'}`, req.user.sub]
      : [storeId, productId, 'arrival', quantity, `Invoice ${invoiceNumber || 'N/A'}`, req.user.sub];
    const movePlaceholders = moveValues.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(
      `INSERT INTO stock_movements ${moveCols} VALUES (${movePlaceholders}) ON CONFLICT (id) DO NOTHING`,
      moveValues
    );

    // Expiry & Batch Tracking: only arrivals with an expiry date create a
    // trackable batch. The UNIQUE(arrival_id) constraint is the second
    // line of defense against a replayed offline request double-creating one.
    if (expiryDate) {
      await client.query(
        `INSERT INTO batches (store_id, product_id, batch_number, expiry_date, quantity_received, arrival_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (arrival_id) DO NOTHING`,
        [storeId, productId, batchNumber || null, expiryDate, quantity, arrival.id]
      );
    }

    await recomputeProductQuantities(client, productId);
    await client.query('COMMIT');

    res.status(201).json(arrival);
    try {
      emitToStore(storeId, 'arrival:created', arrival);
      const { rows: updatedProduct } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
      emitToStore(storeId, 'product:updated', updatedProduct[0]);
    } catch (sideEffectErr) {
      console.error('createArrival: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to record arrival' });
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// Stock Movements
// ------------------------------------------------------------

// GET /api/stores/:storeId/movements
async function listMovements(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT sm.*, p.name AS product_name, p.sku FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     WHERE sm.store_id = $1 ORDER BY sm.created_at DESC LIMIT 500`,
    [storeId]
  );
  res.json(rows);
}

const VALID_MOVEMENT_TYPES = ['transfer_to_shelf', 'sale', 'damage', 'expiry', 'adjustment'];

// POST /api/stores/:storeId/movements
async function createMovement(req, res) {
  const { storeId } = req.params;
  const { id, productId, type, quantity, note } = req.body;
  if (!productId || !VALID_MOVEMENT_TYPES.includes(type) || quantity === undefined) {
    return res.status(400).json({ error: `type must be one of ${VALID_MOVEMENT_TYPES.join(', ')}` });
  }

  if (id) {
    const { rows: existing } = await db.query('SELECT * FROM stock_movements WHERE id = $1', [id]);
    if (existing[0]) return res.status(201).json(existing[0]); // already applied — safe no-op
  }

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  const product = productRows[0];
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

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const cols = id
      ? '(id, store_id, product_id, type, quantity, note, performed_by)'
      : '(store_id, product_id, type, quantity, note, performed_by)';
    const values = id
      ? [id, storeId, productId, type, quantity, note || null, req.user.sub]
      : [storeId, productId, type, quantity, note || null, req.user.sub];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query(
      `INSERT INTO stock_movements ${cols} VALUES (${placeholders}) RETURNING *`,
      values
    );
    await recomputeProductQuantities(client, productId);
    await client.query('COMMIT');

    res.status(201).json(rows[0]);
    try {
      emitToStore(storeId, 'movement:created', rows[0]);
      const { rows: updatedProduct } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
      emitToStore(storeId, 'product:updated', updatedProduct[0]);
    } catch (sideEffectErr) {
      console.error('createMovement: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to record movement' });
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// Shelf Audits
// ------------------------------------------------------------

// GET /api/stores/:storeId/audits?area=
async function listAudits(req, res) {
  const { storeId } = req.params;
  const { area } = req.query;
  const { rows } = await db.query(
    `SELECT sa.*, p.name AS product_name, p.sku, p.location, u.name AS performed_by_name
     FROM shelf_audits sa
     JOIN products p ON p.id = sa.product_id
     LEFT JOIN users u ON u.id = sa.performed_by
     WHERE sa.store_id = $1 ${area ? 'AND sa.area = $2' : ''}
     ORDER BY sa.created_at DESC`,
    area ? [storeId, area] : [storeId]
  );
  res.json(rows);
}

// How recent a prior count at the same location has to be to count as a
// live disagreement worth flagging, rather than just "the count changed
// since this was last audited weeks ago" (which is normal and expected).
const CONFLICT_WINDOW_HOURS = 48;

async function notifyStore(client, storeId, { type, severity, audienceRole, userId, conflictGroupId, message }) {
  await client.query(
    `INSERT INTO store_notifications (store_id, type, severity, audience_role, user_id, conflict_group_id, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [storeId, type, severity || 'amber', audienceRole || null, userId || null, conflictGroupId || null, message]
  );
}

// POST /api/stores/:storeId/audits
// body: { id?, adjustmentMovementId?, productId, countedQty, confidenceSource?, autoAdjust?,
//         area? ('shelf'|'backroom'|'warehouse'), floorNumber?, shelfNumber?, rowNumber?, zone?, conflictGroupId? }
// A manual, physical count at a specific location. 'shelf' reconciles
// against products.shelf_qty (front-of-store); 'backroom'/'warehouse'
// reconcile against products.backroom_qty instead.
async function createAudit(req, res) {
  const { storeId } = req.params;
  const {
    id, adjustmentMovementId, productId, countedQty, confidenceSource, autoAdjust,
    area, floorNumber, shelfNumber, rowNumber, zone, conflictGroupId,
  } = req.body;
  if (!productId || countedQty === undefined) return res.status(400).json({ error: 'productId and countedQty are required' });
  const auditArea = ['shelf', 'backroom', 'warehouse'].includes(area) ? area : 'shelf';

  if (id) {
    const { rows: existing } = await db.query('SELECT * FROM shelf_audits WHERE id = $1', [id]);
    if (existing[0]) return res.status(201).json(existing[0]); // already applied — safe no-op
  }

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const expected = auditArea === 'shelf' ? product.shelf_qty : product.backroom_qty;
  const discrepancy = countedQty - expected;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // A recount explicitly attaches to an existing conflict — a normal
    // fresh count instead checks whether it disagrees with a recent count
    // by a DIFFERENT stocktaker at the exact same location.
    let groupId = conflictGroupId || null;
    let flagged = !!conflictGroupId;

    if (!conflictGroupId) {
      const { rows: priorConflictRows } = await client.query(
        `SELECT * FROM shelf_audits
         WHERE store_id = $1 AND product_id = $2 AND area = $3
           AND COALESCE(floor_number,'') = COALESCE($4,'') AND COALESCE(shelf_number,'') = COALESCE($5,'')
           AND COALESCE(row_number,'') = COALESCE($6,'') AND COALESCE(zone,'') = COALESCE($7,'')
           AND performed_by IS NOT NULL AND performed_by != $8
           AND counted_qty != $9
           AND status != 'resolved'
           AND created_at >= now() - interval '${CONFLICT_WINDOW_HOURS} hours'
         ORDER BY created_at DESC LIMIT 1`,
        [storeId, productId, auditArea, floorNumber || null, shelfNumber || null, rowNumber || null, zone || null, req.user.sub, countedQty]
      );
      const priorConflict = priorConflictRows[0];
      if (priorConflict) {
        groupId = priorConflict.conflict_group_id || require('crypto').randomUUID();
        flagged = true;
        await client.query(`UPDATE shelf_audits SET status = 'needs_recount', conflict_group_id = $1 WHERE id = $2`, [groupId, priorConflict.id]);
      }
    }

    const insertCols = id
      ? `(id, store_id, product_id, counted_qty, expected_qty, discrepancy, confidence_source, auto_adjusted,
          area, floor_number, shelf_number, row_number, zone, status, conflict_group_id, performed_by)`
      : `(store_id, product_id, counted_qty, expected_qty, discrepancy, confidence_source, auto_adjusted,
          area, floor_number, shelf_number, row_number, zone, status, conflict_group_id, performed_by)`;
    const insertValues = [
      ...(id ? [id] : []),
      storeId, productId, countedQty, expected, discrepancy, confidenceSource || 'manual_count', !!autoAdjust,
      auditArea, floorNumber || null, shelfNumber || null, rowNumber || null, zone || null,
      flagged ? 'needs_recount' : 'confirmed', groupId, req.user.sub,
    ];
    const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: auditRows } = await client.query(
      `INSERT INTO shelf_audits ${insertCols} VALUES (${insertPlaceholders}) RETURNING *`,
      insertValues
    );
    const auditId = auditRows[0].id;

    if (flagged) {
      const locationLabel = [floorNumber && `Floor ${floorNumber}`, shelfNumber && `Shelf ${shelfNumber}`, rowNumber && `Row ${rowNumber}`, zone]
        .filter(Boolean).join(', ') || auditArea;
      const message = `Recount needed: ${product.name} at ${locationLabel} — counts disagree (latest: ${countedQty}).`;
      await notifyStore(client, storeId, { type: 'recount_needed', severity: 'amber', audienceRole: 'admin', conflictGroupId: groupId, message });
      // Notify every distinct stocktaker who has counted this location as
      // part of the conflict so far, so both/all of them see the amber
      // alert, not just whoever triggered this particular submission.
      const { rows: performers } = await client.query(
        `SELECT DISTINCT performed_by FROM shelf_audits WHERE conflict_group_id = $1 AND performed_by IS NOT NULL`,
        [groupId]
      );
      for (const p of performers) {
        await notifyStore(client, storeId, { type: 'recount_needed', severity: 'amber', userId: p.performed_by, conflictGroupId: groupId, message });
      }
    }

    if (autoAdjust && discrepancy !== 0 && !flagged) {
      const movementType = auditArea === 'shelf' ? 'adjustment' : 'backroom_adjustment';
      const moveCols = adjustmentMovementId
        ? '(id, store_id, product_id, type, quantity, note, performed_by)'
        : '(store_id, product_id, type, quantity, note, performed_by)';
      const moveValues = adjustmentMovementId
        ? [adjustmentMovementId, storeId, productId, movementType, discrepancy, `Auto-adjusted from ${auditArea} audit`, req.user.sub]
        : [storeId, productId, movementType, discrepancy, `Auto-adjusted from ${auditArea} audit`, req.user.sub];
      const movePlaceholders = moveValues.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `INSERT INTO stock_movements ${moveCols} VALUES (${movePlaceholders}) ON CONFLICT (id) DO NOTHING`,
        moveValues
      );
      await recomputeProductQuantities(client, productId);
    }

    await client.query('COMMIT');

    res.status(201).json({ ...auditRows[0], flaggedForRecount: flagged });

    // Everything below is a post-response side effect (realtime sync,
    // push notifications) — deliberately outside the try's error path
    // now: a failure here must never attempt res.status(500) after a
    // 201 already went out, since that throws "Cannot set headers after
    // they are sent to the client" and used to get caught by the outer
    // catch block below, which tried to do exactly that.
    try {
      const { rows: auditRowJoined } = await db.query(
        `SELECT sa.*, p.name AS product_name FROM shelf_audits sa JOIN products p ON p.id = sa.product_id WHERE sa.id = $1`,
        [auditId]
      );
      emitToStore(storeId, 'audit:created', auditRowJoined[0]);
      const { rows: updatedProduct } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
      emitToStore(storeId, 'product:updated', updatedProduct[0]);

      if (flagged) {
        const locationLabel = [floorNumber && `Floor ${floorNumber}`, shelfNumber && `Shelf ${shelfNumber}`, rowNumber && `Row ${rowNumber}`, zone]
          .filter(Boolean).join(', ') || auditArea;
        const pushBody = `${product.name} at ${locationLabel} — counts disagree, recount needed.`;
        sendPushToStore(storeId, { title: 'Recount needed', body: pushBody, data: { type: 'recount_needed', conflictGroupId: groupId } });
      }
    } catch (sideEffectErr) {
      console.error('createAudit: post-response realtime/push side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to record audit' });
  } finally {
    client.release();
  }
}

// GET /api/stores/:storeId/audits/conflicts?mine=true
// Open recount conflicts. Admins see everything; a stocktaker passing
// ?mine=true sees only conflicts they're personally party to.
async function listConflicts(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT sa.conflict_group_id, p.id AS product_id, p.name AS product_name, sa.area,
            sa.floor_number, sa.shelf_number, sa.row_number, sa.zone,
            json_agg(json_build_object(
              'id', sa.id, 'countedQty', sa.counted_qty, 'performedBy', sa.performed_by,
              'performedByName', u.name, 'createdAt', sa.created_at
            ) ORDER BY sa.created_at) AS entries
     FROM shelf_audits sa
     JOIN products p ON p.id = sa.product_id
     LEFT JOIN users u ON u.id = sa.performed_by
     WHERE sa.store_id = $1 AND sa.status = 'needs_recount' AND sa.conflict_group_id IS NOT NULL
     GROUP BY sa.conflict_group_id, p.id, p.name, sa.area, sa.floor_number, sa.shelf_number, sa.row_number, sa.zone
     ORDER BY MAX(sa.created_at) DESC`,
    [storeId]
  );

  const conflicts = [];
  for (const r of rows) {
    const { rows: acceptanceRows } = await db.query(
      `SELECT user_id FROM audit_conflict_acceptances WHERE conflict_group_id = $1`,
      [r.conflict_group_id]
    );
    conflicts.push({ ...r, acceptances: acceptanceRows.map((a) => a.user_id) });
  }

  const mine = req.query.mine === 'true';
  const filtered = mine
    ? conflicts.filter((c) => c.entries.some((e) => e.performedBy === req.user.sub))
    : conflicts;

  res.json(filtered);
}

// POST /api/stores/:storeId/audits/conflicts/:groupId/accept
// The counterpart stocktaker(s) confirm the latest recount figure is
// correct. Once every distinct original performer (other than whoever
// submitted the latest count in the group) has accepted, the whole group
// resolves and the admin gets notified it's settled.
async function acceptRecount(req, res) {
  const { storeId, groupId } = req.params;
  const { rows: audits } = await db.query(
    `SELECT * FROM shelf_audits WHERE store_id = $1 AND conflict_group_id = $2 ORDER BY created_at ASC`,
    [storeId, groupId]
  );
  if (audits.length === 0) return res.status(404).json({ error: 'Conflict not found' });

  const latest = audits[audits.length - 1];
  if (latest.performed_by === req.user.sub) {
    return res.status(400).json({ error: "You submitted the latest count — the other stocktaker(s) need to accept it, not you" });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO audit_conflict_acceptances (conflict_group_id, user_id) VALUES ($1,$2) ON CONFLICT (conflict_group_id, user_id) DO NOTHING`,
      [groupId, req.user.sub]
    );

    const distinctPerformers = [...new Set(audits.map((a) => a.performed_by).filter((p) => p && p !== latest.performed_by))];
    const { rows: acceptedRows } = await client.query(`SELECT user_id FROM audit_conflict_acceptances WHERE conflict_group_id = $1`, [groupId]);
    const acceptedBy = acceptedRows.map((a) => a.user_id);
    const allAccepted = distinctPerformers.every((p) => acceptedBy.includes(p));

    if (allAccepted) {
      await client.query(
        `UPDATE shelf_audits SET status = 'resolved', resolved_by = $1, resolved_at = now() WHERE conflict_group_id = $2`,
        [req.user.sub, groupId]
      );

      const { rows: productNameRows } = await client.query('SELECT name FROM products WHERE id = $1', [latest.product_id]);
      await notifyStore(client, storeId, {
        type: 'recount_resolved', severity: 'info', audienceRole: 'admin',
        conflictGroupId: groupId,
        message: `Recount resolved for ${productNameRows[0].name} — confirmed count: ${latest.counted_qty}.`,
      });

      // The confirmed figure is now authoritative — apply it the same way a
      // normal auto-adjusted audit would, if it wasn't already.
      const { rows: productRows } = await client.query('SELECT * FROM products WHERE id = $1', [latest.product_id]);
      const productRow = productRows[0];
      const currentExpected = latest.area === 'shelf' ? productRow.shelf_qty : productRow.backroom_qty;
      const finalDiscrepancy = latest.counted_qty - currentExpected;
      if (finalDiscrepancy !== 0) {
        const movementType = latest.area === 'shelf' ? 'adjustment' : 'backroom_adjustment';
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [storeId, latest.product_id, movementType, finalDiscrepancy, 'Applied after recount resolution', req.user.sub]
        );
        await recomputeProductQuantities(client, latest.product_id);
      }
    }

    await client.query('COMMIT');
    res.json({ resolved: allAccepted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to accept recount' });
  } finally {
    client.release();
  }
}

// GET /api/stores/:storeId/audits/report?from=&to=&productId=
//
// A comprehensive, per-product reconciliation: for every product (or one,
// if productId is given), how much arrived and when, how much sold/was
// damaged in the window, what the system currently expects on the shelf
// and in the backroom/warehouse, and what the most recent physical count
// at each location actually found.
async function auditReport(req, res) {
  const { storeId } = req.params;
  const { from, to, productId } = req.query;
  const toDate = to || new Date().toISOString();

  const { rows: products } = productId
    ? await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId])
    : await db.query('SELECT * FROM products WHERE store_id = $1 ORDER BY name ASC', [storeId]);

  const report = [];
  for (const product of products) {
    const { rows: firstArrivalRows } = await db.query('SELECT MIN(created_at) AS d FROM stock_arrivals WHERE product_id = $1', [product.id]);
    const fromDate = from || firstArrivalRows[0].d || product.created_at;

    const { rows: activityRows } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'arrival' THEN quantity ELSE 0 END), 0) AS received_qty,
         COALESCE(SUM(CASE WHEN type = 'sale' THEN quantity ELSE 0 END), 0) AS sold_qty,
         COALESCE(SUM(CASE WHEN type IN ('damage','expiry') THEN quantity ELSE 0 END), 0) AS damaged_qty,
         COALESCE(SUM(CASE WHEN type = 'transfer_to_shelf' THEN quantity ELSE 0 END), 0) AS transferred_to_shelf_qty
       FROM stock_movements
       WHERE product_id = $1 AND created_at BETWEEN $2 AND $3`,
      [product.id, fromDate, toDate]
    );
    const activity = activityRows[0];

    const { rows: arrivals } = await db.query(
      `SELECT id, quantity, invoice_number, expiry_date, created_at FROM stock_arrivals
       WHERE product_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at ASC`,
      [product.id, fromDate, toDate]
    );

    const { rows: latestShelfAuditRows } = await db.query(
      `SELECT sa.*, u.name AS performed_by_name FROM shelf_audits sa LEFT JOIN users u ON u.id = sa.performed_by
       WHERE sa.product_id = $1 AND sa.area = 'shelf' AND sa.created_at BETWEEN $2 AND $3
       ORDER BY sa.created_at DESC LIMIT 1`,
      [product.id, fromDate, toDate]
    );
    const { rows: latestBackroomAuditRows } = await db.query(
      `SELECT sa.*, u.name AS performed_by_name FROM shelf_audits sa LEFT JOIN users u ON u.id = sa.performed_by
       WHERE sa.product_id = $1 AND sa.area IN ('backroom','warehouse') AND sa.created_at BETWEEN $2 AND $3
       ORDER BY sa.created_at DESC LIMIT 1`,
      [product.id, fromDate, toDate]
    );
    const latestShelfAudit = latestShelfAuditRows[0] || null;
    const latestBackroomAudit = latestBackroomAuditRows[0] || null;

    const systemTotalQty = product.shelf_qty + product.backroom_qty;
    const countedTotalQty = (latestShelfAudit ? latestShelfAudit.counted_qty : product.shelf_qty)
      + (latestBackroomAudit ? latestBackroomAudit.counted_qty : product.backroom_qty);

    report.push({
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      location: product.location,
      periodFrom: fromDate,
      periodTo: toDate,
      firstArrivalDate: firstArrivalRows[0].d,
      receivedQty: activity.received_qty,
      soldQty: activity.sold_qty,
      damagedQty: activity.damaged_qty,
      transferredToShelfQty: activity.transferred_to_shelf_qty,
      arrivals,
      systemShelfQty: product.shelf_qty,
      systemBackroomQty: product.backroom_qty,
      systemTotalQty,
      shelfAudit: latestShelfAudit,
      backroomAudit: latestBackroomAudit,
      countedTotalQty: (latestShelfAudit || latestBackroomAudit) ? countedTotalQty : null,
      totalDiscrepancy: (latestShelfAudit || latestBackroomAudit) ? countedTotalQty - systemTotalQty : null,
    });
  }

  res.json(report);
}

module.exports = {
  listArrivals, createArrival,
  listMovements, createMovement,
  listAudits, createAudit, auditReport,
  listConflicts, acceptRecount,
};

// ------------------------------------------------------------
// Store-facing webhook management for the standalone web edition.
// Postgres-flavored twin of desktop/server/controllers/webhooksController.js
// — see utils/webhooks.js for dispatch. `events` is deliberately kept as a
// JSON-string column (not native Postgres array/JSONB) so it round-trips
// identically to desktop's SQLite storage — see migrations/018's header.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');

const AVAILABLE_EVENTS = [
  'receipt.applied',
  'order.paid',
  'purchase_order.auto_created',
  'batch.expiring',
  'cycle_count.high_priority',
  'support_ticket.created',
  'support_ticket.replied',
];

// GET /api/stores/:storeId/webhooks
async function listWebhooks(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT id, url, events, active, last_triggered_at, last_status_code, created_at
     FROM webhooks WHERE store_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [storeId]
  );
  // Secret is deliberately never returned after creation — treat it like a password.
  res.json({ webhooks: rows.map((r) => ({ ...r, events: JSON.parse(r.events) })), availableEvents: AVAILABLE_EVENTS });
}

// POST /api/stores/:storeId/webhooks   { url, events: [] }
async function createWebhook(req, res) {
  const { storeId } = req.params;
  const { url, events } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const validEvents = (events || []).filter((e) => AVAILABLE_EVENTS.includes(e));
  if (validEvents.length === 0) return res.status(400).json({ error: 'At least one valid event is required' });

  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO webhooks (store_id, url, secret, events, created_by) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, url, events, active, created_at`,
    [storeId, url, secret, JSON.stringify(validEvents), req.user.sub]
  );
  // The secret is only ever shown once, at creation — store it now, it
  // can't be retrieved again (a new one can always be issued by recreating
  // the webhook).
  res.status(201).json({ ...rows[0], events: JSON.parse(rows[0].events), secret });
}

// PATCH /api/stores/:storeId/webhooks/:id   { url?, events?, active? }
async function updateWebhook(req, res) {
  const { storeId, id } = req.params;
  const { rows: existingRows } = await db.query(
    'SELECT * FROM webhooks WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL',
    [id, storeId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });

  const { url, events, active } = req.body;
  const validEvents = events ? events.filter((e) => AVAILABLE_EVENTS.includes(e)) : null;

  const { rows } = await db.query(
    `UPDATE webhooks SET url = $1, events = $2, active = $3, updated_at = now() WHERE id = $4
     RETURNING id, url, events, active, last_triggered_at, last_status_code, created_at`,
    [url || existing.url, validEvents ? JSON.stringify(validEvents) : existing.events,
     active === undefined ? existing.active : !!active, id]
  );
  res.json({ ...rows[0], events: JSON.parse(rows[0].events) });
}

// DELETE /api/stores/:storeId/webhooks/:id
// Soft delete (see this file's header) — never a hard DELETE.
async function deleteWebhook(req, res) {
  const { storeId, id } = req.params;
  const { rowCount } = await db.query(
    `UPDATE webhooks SET deleted_at = now(), updated_at = now() WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL`,
    [id, storeId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Webhook not found' });
  res.status(204).end();
}

// POST /api/stores/:storeId/webhooks/:id/test — fires a synthetic event so
// an admin can verify their endpoint receives and can verify the signature
// without waiting for a real receipt/order/etc.
async function testWebhook(req, res) {
  const { storeId, id } = req.params;
  const { rows } = await db.query('SELECT * FROM webhooks WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL', [id, storeId]);
  const hook = rows[0];
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });

  const testPayload = { message: 'This is a test event from SAFE Stores.' };
  const body = JSON.stringify({ event: 'test', storeId, data: testPayload, sentAt: new Date().toISOString() });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

  try {
    const resp = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SafeStores-Event': 'test', 'X-SafeStores-Signature': signature },
      body,
    });
    await db.query('UPDATE webhooks SET last_triggered_at = now(), last_status_code = $1 WHERE id = $2', [resp.status, id]);
    res.json({ delivered: true, statusCode: resp.status });
  } catch (err) {
    res.json({ delivered: false, error: err.message });
  }
}

module.exports = { listWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, AVAILABLE_EVENTS };

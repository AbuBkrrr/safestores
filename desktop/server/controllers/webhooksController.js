// ------------------------------------------------------------
// Store-facing webhook management — see utils/webhooks.js for dispatch.
//
// Syncs across a store's devices like everything else (see
// syncController.js) — created/updated_at drive last-write-wins merging,
// and delete is a tombstone (deleted_at set) rather than a hard DELETE, so
// a delete on one device can't be silently undone by a later sync pulling
// in an older snapshot from another device that doesn't know about it yet.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../db');

const AVAILABLE_EVENTS = [
  'receipt.applied',
  'order.paid',
  'purchase_order.auto_created',
  'batch.expiring',
  'cycle_count.high_priority',
  'support_ticket.created',
  'support_ticket.replied',
];

function now() { return new Date().toISOString(); }

// GET /api/stores/:storeId/webhooks
function listWebhooks(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT id, url, events, active, last_triggered_at, last_status_code, created_at
     FROM webhooks WHERE store_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
  ).all(storeId).map((r) => ({ ...r, events: JSON.parse(r.events), active: !!r.active }));
  // Secret is deliberately never returned after creation — treat it like a password.
  res.json({ webhooks: rows, availableEvents: AVAILABLE_EVENTS });
}

// POST /api/stores/:storeId/webhooks   { url, events: [] }
function createWebhook(req, res) {
  const { storeId } = req.params;
  const { url, events } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const validEvents = (events || []).filter((e) => AVAILABLE_EVENTS.includes(e));
  if (validEvents.length === 0) return res.status(400).json({ error: 'At least one valid event is required' });

  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString('hex');
  const ts = now();
  db.prepare(
    `INSERT INTO webhooks (id, store_id, url, secret, events, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, storeId, url, secret, JSON.stringify(validEvents), req.user.sub, ts, ts);

  const row = db.prepare('SELECT id, url, events, active, created_at FROM webhooks WHERE id = ?').get(id);
  // The secret is only ever shown once, at creation — store it now, it
  // can't be retrieved again (a new one can always be issued by recreating
  // the webhook).
  res.status(201).json({ ...row, events: JSON.parse(row.events), active: !!row.active, secret });
}

// PATCH /api/stores/:storeId/webhooks/:id   { url?, events?, active? }
function updateWebhook(req, res) {
  const { storeId, id } = req.params;
  const existing = db.prepare('SELECT * FROM webhooks WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(id, storeId);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });

  const { url, events, active } = req.body;
  const validEvents = events ? events.filter((e) => AVAILABLE_EVENTS.includes(e)) : null;

  db.prepare(
    `UPDATE webhooks SET url = ?, events = ?, active = ?, updated_at = ? WHERE id = ?`
  ).run(
    url || existing.url,
    validEvents ? JSON.stringify(validEvents) : existing.events,
    active === undefined ? existing.active : (active ? 1 : 0),
    now(), id
  );
  const row = db.prepare('SELECT id, url, events, active, last_triggered_at, last_status_code, created_at FROM webhooks WHERE id = ?').get(id);
  res.json({ ...row, events: JSON.parse(row.events), active: !!row.active });
}

// DELETE /api/stores/:storeId/webhooks/:id
// Soft delete (see this file's header) — never a hard DELETE.
function deleteWebhook(req, res) {
  const { storeId, id } = req.params;
  const ts = now();
  const result = db.prepare(
    'UPDATE webhooks SET deleted_at = ?, updated_at = ? WHERE id = ? AND store_id = ? AND deleted_at IS NULL'
  ).run(ts, ts, id, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Webhook not found' });
  res.status(204).end();
}

// POST /api/stores/:storeId/webhooks/:id/test — fires a synthetic event so
// an admin can verify their endpoint receives and can verify the signature
// without waiting for a real receipt/order/etc.
async function testWebhook(req, res) {
  const { storeId, id } = req.params;
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(id, storeId);
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
    db.prepare(`UPDATE webhooks SET last_triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status_code = ? WHERE id = ?`)
      .run(resp.status, id);
    res.json({ delivered: true, statusCode: resp.status });
  } catch (err) {
    res.json({ delivered: false, error: err.message });
  }
}

module.exports = { listWebhooks, createWebhook, updateWebhook, deleteWebhook, testWebhook, AVAILABLE_EVENTS };

// ------------------------------------------------------------
// Outbound webhooks — the generic "integrations" answer, desktop
// counterpart of backend/src/utils/webhooks.js (same delivery semantics:
// fire-and-forget, HMAC-SHA256 signed, best-effort not retried/queued).
// Subscriptions are configured locally now (see webhooksController.js) —
// every event this app fires, whether the underlying data is local
// (receipts, orders, purchase orders, batches) or bridged from the cloud
// (support tickets), dispatches from here using this device's config.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../db');

/**
 * @param {string} storeId
 * @param {string} eventName - e.g. 'receipt.applied', 'order.paid', 'purchase_order.auto_created'
 * @param {object} payload - JSON-serializable event data
 */
function dispatchEvent(storeId, eventName, payload) {
  let hooks;
  try {
    hooks = db.prepare('SELECT * FROM webhooks WHERE store_id = ? AND active = 1 AND deleted_at IS NULL').all(storeId)
      .filter((h) => JSON.parse(h.events).includes(eventName));
  } catch (err) {
    console.error('Webhook lookup failed:', err.message);
    return;
  }

  for (const hook of hooks) {
    const body = JSON.stringify({ event: eventName, storeId, data: payload, sentAt: new Date().toISOString() });
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

    fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SafeStores-Event': eventName,
        // Verify on your side: HMAC-SHA256(body, your webhook secret) === this header.
        'X-SafeStores-Signature': signature,
      },
      body,
    })
      .then((resp) => {
        db.prepare(`UPDATE webhooks SET last_triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status_code = ? WHERE id = ?`)
          .run(resp.status, hook.id);
      })
      .catch((err) => {
        console.error(`Webhook delivery failed (${hook.url}):`, err.message);
        db.prepare(`UPDATE webhooks SET last_triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status_code = NULL WHERE id = ?`)
          .run(hook.id);
      });
  }
}

module.exports = { dispatchEvent };

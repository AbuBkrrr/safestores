// ------------------------------------------------------------
// Outbound webhooks — the generic "integrations" answer.
//
// Rather than building a bespoke integration for every accounting tool,
// e-commerce platform, or in-house script a store might want to connect,
// a store admin registers a URL + which events they care about (see
// webhooksController.js / the Integrations frontend page), and this fires
// an HMAC-signed POST whenever one of those events happens. Zapier,
// Make/Integromat, a Google Sheets Apps Script webhook, or custom
// software can all subscribe without us writing vendor-specific code.
//
// Delivery is fire-and-forget (best-effort, not retried/queued) — this is
// deliberately simple; if a store needs guaranteed delivery/retries later,
// swap the body of the loop below for a queue-backed job instead of
// changing anything at the call sites.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');

/**
 * @param {string} storeId
 * @param {string} eventName - e.g. 'receipt.applied', 'order.paid', 'purchase_order.auto_created'
 * @param {object} payload - JSON-serializable event data
 */
async function dispatchEvent(storeId, eventName, payload) {
  let hooks;
  try {
    // `events` is a JSON-string column, not a native Postgres array — see
    // migrations/018_webhook_sync_support.sql and webhooksController.js.
    // `?` is jsonb's "does this string exist as a top-level array element"
    // operator — exactly what we need for a JSON array of event names.
    // Also exclude soft-deleted hooks (deleted_at), which the original
    // query didn't do either.
    ({ rows: hooks } = await db.query(
      `SELECT * FROM webhooks WHERE store_id = $1 AND active = true AND deleted_at IS NULL AND events::jsonb ? $2`,
      [storeId, eventName]
    ));
  } catch (err) {
    console.error('Webhook lookup failed:', err.message);
    return;
  }

  for (const hook of hooks) {
    const body = JSON.stringify({
      event: eventName,
      storeId,
      data: payload,
      sentAt: new Date().toISOString(),
    });
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
        db.query(
          `UPDATE webhooks SET last_triggered_at = now(), last_status_code = $1 WHERE id = $2`,
          [resp.status, hook.id]
        ).catch(() => {});
      })
      .catch((err) => {
        console.error(`Webhook delivery failed (${hook.url}):`, err.message);
        db.query(
          `UPDATE webhooks SET last_triggered_at = now(), last_status_code = NULL WHERE id = $1`,
          [hook.id]
        ).catch(() => {});
      });
  }
}

module.exports = { dispatchEvent };

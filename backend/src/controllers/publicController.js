// ------------------------------------------------------------
// Public, no-login endpoints for shoppers and search engines:
//   GET /api/public/marketplace-orders/:token  — order tracking page data
//   GET /share/shop/:storeId                   — share-preview HTML (WhatsApp/Facebook/X
//                                                read Open Graph tags; they don't run JS)
//   GET /sitemap.xml, /robots.txt              — search-engine discovery
// ------------------------------------------------------------
const db = require('../config/db');

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID = /^[0-9a-f-]{36}$/i;

async function trackOrder(req, res) {
  const { rows } = await db.query(
    `SELECT mo.id, mo.status, mo.subtotal, mo.total, mo.created_at, mo.fulfilled_at, mo.loyalty_discount_pct,
            mo.payment_method, mo.payment_status, mo.paid_at, mo.transfer_sent_at, mo.cancel_reason, mo.fulfilment_method, mo.status_note, mo.confirmed_at, mo.dispatched_at, s.online_payments_enabled AND s.payout_subaccount_code IS NOT NULL AS can_pay_online,
            CASE WHEN mo.payment_method = 'transfer' THEN json_build_object('bankName', s.transfer_bank_name, 'accountNumber', s.transfer_account_number,
              'accountName', s.transfer_account_name, 'note', s.transfer_note) END AS transfer,
            s.name AS store_name, s.phone AS store_phone, s.address AS store_address, s.city AS store_city,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id LEFT JOIN currency_settings c ON c.id = 'default'
     WHERE mo.tracking_token = $1`,
    [req.params.token]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await db.query(
    `SELECT p.name, moi.quantity, moi.unit_price FROM marketplace_order_items moi JOIN products p ON p.id = moi.product_id WHERE moi.marketplace_order_id = $1`,
    [rows[0].id]
  ).catch(() => ({ rows: [] }));
  const { id, ...order } = rows[0];
  res.json({ ...order, reference: id.slice(0, 8).toUpperCase(), items });
}

// POST /api/public/marketplace-orders/:token/payment-sent
// The shopper says they have made the bank transfer: tell the shop (chime
// on their screens + phone push) so they can check their bank and confirm.
async function paymentSent(req, res) {
  const { rows } = await db.query(
    `UPDATE marketplace_orders SET transfer_sent_at = now()
      WHERE tracking_token = $1 AND payment_method = 'transfer' AND payment_status <> 'paid' AND status <> 'cancelled'
        AND (transfer_sent_at IS NULL OR transfer_sent_at < now() - interval '10 minutes')
      RETURNING id, store_id, total, transfer_sent_at`,
    [req.params.token]
  );
  if (!rows[0]) {
    const { rows: o } = await db.query('SELECT transfer_sent_at FROM marketplace_orders WHERE tracking_token = $1', [req.params.token]);
    if (!o[0]) return res.status(404).json({ error: 'Order not found' });
    return res.json({ transfer_sent_at: o[0].transfer_sent_at }); // already told the shop just now, or not a transfer order
  }
  const o = rows[0];
  const reference = o.id.slice(0, 8).toUpperCase();
  try { require('../realtime').emitToStore(o.store_id, 'marketplace:payment_sent', { id: o.id, total: o.total, reference }); } catch { /* best-effort */ }
  require('../utils/push').sendPushToStore(o.store_id, {
    title: 'Customer says they have paid',
    body: `Transfer of ${Number(o.total).toFixed(2)} for order ${reference} — check your bank, then tap Money received.`,
    data: { type: 'marketplace.payment_sent', orderId: o.id },
  }).catch(() => {});
  res.json({ transfer_sent_at: o.transfer_sent_at });
}

async function shareShop(req, res) {
  const target = `${frontendBase()}/shop/${encodeURIComponent(req.params.storeId)}`;
  let store = null;
  const storeId = await require('../utils/shopSlug').resolveShopId(req.params.storeId);
  if (storeId) {
    const { rows } = await db.query(
      `SELECT name, category, city FROM stores WHERE id = $1 AND subscription_status = 'active' AND marketplace_enabled = true`, [storeId]
    );
    store = rows[0];
  }
  const title = store ? `${store.name} — shop online` : 'SAFE Stores marketplace';
  const desc = store ? `Browse ${store.name}${store.city ? ` in ${store.city}` : ''}${store.category ? ` (${store.category})` : ''} and order online. No account needed.` : 'Shop from local stores online.';
  res.set('Cache-Control', 'public, max-age=600').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(target)}">
<meta property="og:image" content="${esc(`${frontendBase()}/icon-512.png`)}">
<meta name="twitter:card" content="summary"><link rel="canonical" href="${esc(target)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head>
<body><p><a href="${esc(target)}">${esc(title)}</a></p></body></html>`);
}

async function sitemap(req, res) {
  const base = frontendBase();
  const { rows } = await db.query(
    `SELECT id, shop_slug, updated_at FROM stores WHERE subscription_status = 'active' AND marketplace_enabled = true ORDER BY name LIMIT 45000`
  );
  const urls = [`<url><loc>${esc(`${base}/marketplace-home`)}</loc><changefreq>daily</changefreq></url>`,
    ...rows.map((r) => `<url><loc>${esc(`${base}/shop/${r.shop_slug || r.id}`)}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod></url>`)];
  res.set('Cache-Control', 'public, max-age=3600').type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
}

function robots(req, res) {
  res.type('text/plain').send(`User-agent: *\nAllow: /share/\nAllow: /sitemap.xml\nDisallow: /api/\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
}

// GET /api/public/stores/:storeId — the storefront header (name, contact) and its currency.
async function storeInfo(req, res) {
  if (!UUID.test(req.params.storeId)) return res.status(404).json({ error: 'Store not found' });
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.category, s.city, s.address, s.phone, s.shop_slug, s.shop_tagline, s.shop_logo_url, s.shop_bg_image_url, s.shop_brand_color, s.shop_bg_color, s.shop_font, s.shop_theme,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default'
     WHERE s.id = $1 AND s.subscription_status = 'active' AND s.marketplace_enabled = true`,
    [req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  const payments = await require('./storePaymentsController').paymentOptionsFor(rows[0].id);
  res.json({ ...rows[0], payments });
}

module.exports = { paymentSent, trackOrder, shareShop, sitemap, robots, storeInfo };

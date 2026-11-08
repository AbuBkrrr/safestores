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

async function shareShop(req, res) {
  const { storeId } = req.params;
  const target = `${frontendBase()}/shop/${encodeURIComponent(storeId)}`;
  let store = null;
  if (UUID.test(storeId)) {
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
    `SELECT id, updated_at FROM stores WHERE subscription_status = 'active' AND marketplace_enabled = true ORDER BY name LIMIT 45000`
  );
  const urls = [`<url><loc>${esc(`${base}/marketplace-home`)}</loc><changefreq>daily</changefreq></url>`,
    ...rows.map((r) => `<url><loc>${esc(`${base}/shop/${r.id}`)}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod></url>`)];
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
    `SELECT s.id, s.name, s.category, s.city, s.address, s.phone,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default'
     WHERE s.id = $1 AND s.subscription_status = 'active' AND s.marketplace_enabled = true`,
    [req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

module.exports = { trackOrder, shareShop, sitemap, robots, storeInfo };

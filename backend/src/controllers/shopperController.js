// The shopper app (public, no login needed): what's on sale, newest stock,
// popular items, the cheapest store for an item, and messages to a store
// (a question about an item, or a request for something it doesn't stock).
const db = require('../config/db');
const { priceSql, regularSql, onSaleSql } = require('../utils/price');
const { emitToStore } = require('../realtime');

const LIVE = `s.subscription_status = 'active' AND s.marketplace_enabled = true AND p.archived_at IS NULL`;
const FIELDS = `p.id, p.name, p.brand, p.category, p.unit, p.sold_by, p.image_url,
  ${priceSql('p')} AS price, ${regularSql('p')} AS regular_price, ${onSaleSql('p')} AS on_sale, p.promo_label, p.promo_ends_at,
  (p.shelf_qty + p.backroom_qty) > 0 AS in_stock, s.id AS store_id, s.name AS store_name, s.city AS store_city, s.shop_slug`;

// GET /api/marketplace/discover?city=
async function discover(req, res) {
  const params = [];
  let city = '';
  if (req.query.city) { params.push(String(req.query.city)); city = ` AND s.city ILIKE $${params.length}`; }
  const q = (sql) => db.query(sql, params).then((r) => r.rows);
  const base = `FROM products p JOIN stores s ON s.id = p.store_id WHERE ${LIVE}${city}`;
  const [deals, newest, popular, stores] = await Promise.all([
    q(`SELECT ${FIELDS}, ROUND(100 - 100 * p.promo_price / NULLIF(p.cost_price * p.price_multiplier, 0)) AS pct_off
       ${base} AND ${onSaleSql('p')} AND (p.shelf_qty + p.backroom_qty) > 0 ORDER BY pct_off DESC NULLS LAST LIMIT 24`),
    q(`SELECT ${FIELDS}, a.last_arrival ${base.replace('WHERE', `JOIN LATERAL (SELECT MAX(created_at) AS last_arrival FROM stock_arrivals sa WHERE sa.product_id = p.id) a ON true WHERE`)}
       AND (p.shelf_qty + p.backroom_qty) > 0 AND COALESCE(a.last_arrival, p.created_at) > now() - interval '21 days'
       ORDER BY COALESCE(a.last_arrival, p.created_at) DESC LIMIT 24`),
    q(`SELECT ${FIELDS}, x.n AS sold ${base.replace('WHERE', `JOIN (SELECT moi.product_id, SUM(moi.quantity) AS n FROM marketplace_order_items moi
         JOIN marketplace_orders mo ON mo.id = moi.marketplace_order_id WHERE mo.created_at > now() - interval '30 days' AND mo.status <> 'cancelled'
         GROUP BY moi.product_id) x ON x.product_id = p.id WHERE`)} AND (p.shelf_qty + p.backroom_qty) > 0 ORDER BY x.n DESC LIMIT 24`),
    q(`SELECT s.id, s.name, s.city, s.category, s.shop_slug, s.shop_logo_url, s.phone,
         COUNT(p.id) FILTER (WHERE (p.shelf_qty + p.backroom_qty) > 0)::int AS items,
         COUNT(p.id) FILTER (WHERE ${onSaleSql('p')})::int AS deals
       FROM stores s LEFT JOIN products p ON p.store_id = s.id AND p.archived_at IS NULL
       WHERE s.subscription_status = 'active' AND s.marketplace_enabled = true${city}
       GROUP BY s.id ORDER BY deals DESC, items DESC LIMIT 60`),
  ]);
  res.json({ deals, newest, popular, stores });
}

// GET /api/marketplace/compare?q=  — the same item across stores, cheapest first.
async function compare(req, res) {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json([]);
  const params = [`%${term}%`];
  let city = '';
  if (req.query.city) { params.push(String(req.query.city)); city = ` AND s.city ILIKE $${params.length}`; }
  const { rows } = await db.query(
    `SELECT ${FIELDS} FROM products p JOIN stores s ON s.id = p.store_id
     WHERE ${LIVE}${city} AND (p.name ILIKE $1 OR p.brand ILIKE $1 OR p.category ILIKE $1)
     ORDER BY (p.shelf_qty + p.backroom_qty) > 0 DESC, ${priceSql('p')} ASC LIMIT 120`, params);
  // Group the same item (same name) so the shopper sees "₦X at Store A — cheapest of N stores".
  const groups = new Map();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: r.name, image_url: r.image_url, offers: [] });
    const g = groups.get(key);
    if (!g.image_url && r.image_url) g.image_url = r.image_url;
    g.offers.push(r);
  }
  res.json([...groups.values()].map((g) => ({ ...g, cheapest: g.offers.find((o) => o.in_stock) || g.offers[0], stores: g.offers.length })));
}

// POST /api/marketplace/:storeId/inquiries  { kind: 'question'|'request', productId?, name, phone?, email?, message }
async function createInquiry(req, res) {
  const { storeId } = req.params;
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 2000);
  if (!name || !message) return res.status(400).json({ error: 'Your name and a message are needed' });
  if (!b.phone && !b.email) return res.status(400).json({ error: 'Add a phone number or email so the shop can reply' });
  const store = (await db.query(`SELECT id FROM stores WHERE id = $1 AND subscription_status = 'active' AND marketplace_enabled = true`, [storeId])).rows[0];
  if (!store) return res.status(404).json({ error: 'Shop not found' });
  const productId = b.productId && (await db.query('SELECT id FROM products WHERE id::text = $1 AND store_id = $2', [String(b.productId), storeId])).rows[0]?.id;
  const { rows } = await db.query(
    `INSERT INTO store_inquiries (store_id, product_id, kind, name, phone, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, token, kind, status, created_at`,
    [storeId, productId || null, b.kind === 'request' ? 'request' : 'question', name, String(b.phone || '').slice(0, 40) || null, String(b.email || '').slice(0, 160) || null]);
  await db.query('INSERT INTO store_inquiry_messages (inquiry_id, from_store, author_name, body) VALUES ($1, false, $2, $3)', [rows[0].id, name, message]);
  try { emitToStore(storeId, 'inquiry:new', { id: rows[0].id }); } catch { /* realtime is optional */ }
  try {
    require('../utils/push').sendPushToStore(storeId, { title: b.kind === 'request' ? 'New item request' : 'A shopper has a question', body: message.slice(0, 120), data: { type: 'inquiry' } });
  } catch { /* push is optional */ }
  res.status(201).json({ token: rows[0].token, kind: rows[0].kind });
}

async function threadOf(where, params) {
  const inq = (await db.query(
    `SELECT i.id, i.kind, i.status, i.name, i.phone, i.email, i.created_at, i.updated_at, i.token, i.store_id,
            s.name AS store_name, s.phone AS store_phone, p.name AS product_name, p.id AS product_id
     FROM store_inquiries i JOIN stores s ON s.id = i.store_id LEFT JOIN products p ON p.id = i.product_id WHERE ${where}`, params)).rows[0];
  if (!inq) return null;
  inq.messages = (await db.query('SELECT from_store, author_name, body, image_url, created_at FROM store_inquiry_messages WHERE inquiry_id = $1 ORDER BY created_at', [inq.id])).rows;
  return inq;
}

// GET /api/marketplace/inquiries/:token  (the shopper's own thread)
async function getInquiry(req, res) {
  const t = await threadOf('i.token = $1', [String(req.params.token).slice(0, 40)]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { id, ...out } = t;
  res.json(out);
}

// POST /api/marketplace/inquiries/:token/reply  { message }
async function shopperReply(req, res) {
  const t = await threadOf('i.token = $1', [String(req.params.token).slice(0, 40)]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const body = String(req.body?.message || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a message' });
  await db.query('INSERT INTO store_inquiry_messages (inquiry_id, from_store, author_name, body) VALUES ($1, false, $2, $3)', [t.id, t.name, body]);
  await db.query(`UPDATE store_inquiries SET status = 'open', updated_at = now() WHERE id = $1`, [t.id]);
  try { emitToStore(t.store_id, 'inquiry:new', { id: t.id }); } catch { /* optional */ }
  res.status(201).json({ ok: true });
}

// ---- store side
// GET /api/stores/:storeId/inquiries
async function listForStore(req, res) {
  const { rows } = await db.query(
    `SELECT i.id, i.kind, i.status, i.name, i.phone, i.email, i.created_at, i.updated_at, p.name AS product_name,
            CASE WHEN i.order_id IS NOT NULL THEN upper(substr(i.order_id::text, 1, 8)) END AS order_ref,
            (SELECT COALESCE(body, '📷') FROM store_inquiry_messages m WHERE m.inquiry_id = i.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT json_agg(json_build_object('from_store', m.from_store, 'author_name', m.author_name, 'body', m.body, 'image_url', m.image_url, 'created_at', m.created_at) ORDER BY m.created_at)
               FROM store_inquiry_messages m WHERE m.inquiry_id = i.id) AS messages
     FROM store_inquiries i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.store_id = $1 ORDER BY (i.status = 'open') DESC, i.updated_at DESC LIMIT 200`, [req.params.storeId]);
  res.json(rows);
}

// POST /api/stores/:storeId/inquiries/:id/reply  { message, close? }
async function storeReply(req, res) {
  const { storeId, id } = req.params;
  const inq = (await db.query('SELECT id FROM store_inquiries WHERE id::text = $1 AND store_id = $2', [id, storeId])).rows[0];
  if (!inq) return res.status(404).json({ error: 'Not found' });
  const body = String(req.body?.message || '').trim().slice(0, 2000);
  const me = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.sub])).rows[0];
  if (body) await db.query('INSERT INTO store_inquiry_messages (inquiry_id, from_store, author_name, body) VALUES ($1, true, $2, $3)', [inq.id, me?.name || 'Shop', body]);
  const status = req.body?.close ? 'closed' : body ? 'answered' : null;
  if (status) await db.query('UPDATE store_inquiries SET status = $1, updated_at = now() WHERE id = $2', [status, inq.id]);
  res.json({ ok: true, status });
}

module.exports = { discover, compare, createInquiry, getInquiry, shopperReply, listForStore, storeReply };

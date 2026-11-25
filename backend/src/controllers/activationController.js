// Getting an activation key after sign-up, without leaving the app:
// the store owner asks for one (it reaches Super Admin as a support ticket
// and an email), and the key Super Admin issues shows up on the store's
// activation screen and in the owner's email.
const db = require('../config/db');
const { sendMail } = require('../utils/mailer');

const SUBJECT = 'Activation key request';
const support = () => ({
  email: process.env.SUPPORT_INBOX_EMAIL || null,
  phone: process.env.SUPPORT_PHONE || null,
  whatsapp: process.env.SUPPORT_WHATSAPP || process.env.SUPPORT_PHONE || null,
});

async function openRequest(storeId) {
  return (await db.query(
    `SELECT id, status, created_at FROM support_tickets
     WHERE store_id = $1 AND subject = $2 AND status IN ('open', 'in_progress') ORDER BY created_at DESC LIMIT 1`, [storeId, SUBJECT])).rows[0] || null;
}

// GET /api/stores/:storeId/activation
async function status(req, res) {
  const { storeId } = req.params;
  const store = (await db.query('SELECT subscription_status FROM stores WHERE id = $1', [storeId])).rows[0];
  if (!store) return res.status(404).json({ error: 'Store not found' });
  // A key issued for this store and not used yet: shown to the owner here.
  const key = store.subscription_status === 'active' ? null : (await db.query(
    `SELECT code, expires_at FROM access_codes WHERE issued_for_store = $1 AND status = 'active' AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`, [storeId])).rows[0] || null;
  res.json({ request: await openRequest(storeId), key, support: support() });
}

// POST /api/stores/:storeId/activation/request  body: { phone?, message? }
async function requestKey(req, res) {
  const { storeId } = req.params;
  const existing = await openRequest(storeId);
  if (existing) return res.json({ request: existing, alreadySent: true });
  const store = (await db.query('SELECT name, business_type, requested_tier, store_tier, subscription_status FROM stores WHERE id = $1', [storeId])).rows[0];
  if (!store) return res.status(404).json({ error: 'Store not found' });
  if (store.subscription_status === 'active') return res.status(409).json({ error: 'This store is already active' });
  const me = (await db.query('SELECT name, email FROM users WHERE id = $1', [req.user.sub])).rows[0] || {};
  const phone = String(req.body?.phone || '').trim().slice(0, 40);
  const note = String(req.body?.message || '').trim().slice(0, 1000);
  const message = [
    `${store.name} is registered and needs an activation key.`,
    `Owner: ${me.name || '-'} <${me.email || '-'}>`,
    phone ? `Phone / WhatsApp: ${phone}` : null,
    `Plan asked for: ${store.requested_tier || store.store_tier || '-'}`,
    note ? `Message: ${note}` : null,
  ].filter(Boolean).join('\n');
  const { rows } = await db.query(
    `INSERT INTO support_tickets (store_id, subject, message, priority, created_by_name) VALUES ($1,$2,$3,'high',$4) RETURNING id, status, created_at`,
    [storeId, SUBJECT, message, me.name || null]);
  if (support().email) {
    sendMail({ to: support().email, subject: `[SAFE Stores] Activation key request: ${store.name}`, text: `${message}\n\nStore ID: ${storeId}\nIssue the key from Super Admin → Stores.` });
  }
  res.status(201).json({ request: rows[0] });
}

/** After Super Admin issues a key for a store: email it to the owner(s) and answer their request. */
async function deliverKey(storeId, code, issuedByName = 'SAFE Stores support') {
  const owners = (await db.query(`SELECT email, name FROM users WHERE store_id = $1 AND role = 'admin' AND status = 'active'`, [storeId])).rows;
  const store = (await db.query('SELECT name FROM stores WHERE id = $1', [storeId])).rows[0] || {};
  const expires = new Date(code.expires_at).toDateString();
  const text = `Your activation key for ${store.name || 'your store'} is:\n\n    ${code.code}\n\nSign in and enter it on the activation screen (it is also shown there). It works until ${expires}.`;
  for (const o of owners) if (o.email) sendMail({ to: o.email, subject: `Your activation key for ${store.name || 'your store'}`, text });
  const reqTicket = await openRequest(storeId);
  if (reqTicket) {
    await db.query(`INSERT INTO support_ticket_replies (ticket_id, author_type, author_name, message) VALUES ($1,'super_admin',$2,$3)`,
      [reqTicket.id, issuedByName, `Your activation key has been sent. It is on your activation screen and in your email. It works until ${expires}.`]);
    await db.query(`UPDATE support_tickets SET status = 'resolved', updated_at = now() WHERE id = $1`, [reqTicket.id]);
  }
  return owners.filter((o) => o.email).map((o) => o.email);
}

module.exports = { status, requestKey, deliverKey };

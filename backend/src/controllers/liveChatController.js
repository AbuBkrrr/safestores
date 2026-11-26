// Live support chat for anyone on the website or app (no login needed).
// A chat is a support ticket (source 'chat') that Super Admin answers in
// Support Tickets. The visitor's browser keeps a random secret; only its
// SHA-256 is stored, so a leaked database can't be used to read chats.
const crypto = require('crypto');
const db = require('../config/db');
const { sendMail } = require('../utils/mailer');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const tokenOk = (t) => typeof t === 'string' && /^[a-f0-9]{48}$/.test(t);

async function findChat(token) {
  if (!tokenOk(token)) return null;
  const { rows } = await db.query("SELECT * FROM support_tickets WHERE chat_token_hash = $1 AND source = 'chat'", [hash(token)]);
  return rows[0] || null;
}

function view(t, replies) {
  return {
    status: t.status,
    name: t.contact_name,
    messages: [{ id: `${t.id}-0`, from: 'me', text: t.message, at: t.created_at },
      ...replies.map((r) => ({ id: r.id, from: r.author_type === 'visitor' ? 'me' : 'support', name: r.author_type === 'visitor' ? null : r.author_name, text: r.message, at: r.created_at }))],
  };
}

// POST /api/m/chat  { token?, name?, phone?, email?, message, page? }
async function send(req, res) {
  const b = req.body || {};
  const message = clip(b.message, 2000);
  if (!message) return res.status(400).json({ error: 'Type a message' });
  let t = await findChat(b.token);
  if (t) {
    await db.query("INSERT INTO support_ticket_replies (ticket_id, author_type, author_name, message) VALUES ($1,'visitor',$2,$3)",
      [t.id, t.contact_name || 'Visitor', message]);
    await db.query("UPDATE support_tickets SET status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, updated_at = now(), visitor_seen_at = now() WHERE id = $1", [t.id]);
    return res.status(201).json({ token: b.token });
  }
  const name = clip(b.name, 120) || 'Visitor';
  const email = clip(b.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Check the email address' });
  const token = crypto.randomBytes(24).toString('hex');
  const page = clip(b.page, 120);
  await db.query(
    `INSERT INTO support_tickets (store_id, source, subject, message, priority, contact_name, contact_phone, contact_email, created_by_name, chat_token_hash, visitor_seen_at)
     VALUES (NULL, 'chat', $1, $2, 'high', $3, $4, $5, $3, $6, now())`,
    [`Live chat${page ? ` (${page})` : ''}`.slice(0, 200), message, name, clip(b.phone, 40), email ? email.toLowerCase() : null, hash(token)]);
  if (process.env.SUPPORT_INBOX_EMAIL) {
    sendMail({ to: process.env.SUPPORT_INBOX_EMAIL, subject: `[SAFE Stores] Live chat from ${name}`,
      text: `${message}\n\nAnswer in Super Admin → Support Tickets.` });
  }
  res.status(201).json({ token });
}

// GET /api/m/chat/:token
async function read(req, res) {
  const t = await findChat(req.params.token);
  if (!t) return res.status(404).json({ error: 'Chat not found' });
  const { rows } = await db.query('SELECT * FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at', [t.id]);
  db.query('UPDATE support_tickets SET visitor_seen_at = now() WHERE id = $1', [t.id]).catch(() => {});
  res.json(view(t, rows));
}

module.exports = { send, read };

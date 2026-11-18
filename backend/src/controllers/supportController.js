// ------------------------------------------------------------
// Support tickets — replaces "support is just an email address" with a
// real in-app queue: a store admin/manager raises a ticket, a Super Admin
// sees every store's tickets in one place and replies, both sides get an
// email if SMTP is configured (see utils/mailer.js) in addition to the
// in-app thread either always has.
// ------------------------------------------------------------

const db = require('../config/db');
const { sendMail } = require('../utils/mailer');
const { emitToStore } = require('../realtime');
const { sendPushToStore } = require('../utils/push');
const { dispatchEvent } = require('../utils/webhooks');

const SUPPORT_INBOX_EMAIL = process.env.SUPPORT_INBOX_EMAIL || null;

// ---- Store side ----

// GET /api/stores/:storeId/support/tickets
async function listMyTickets(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    'SELECT * FROM support_tickets WHERE store_id = $1 ORDER BY updated_at DESC', [storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/support/tickets/:id
async function getTicket(req, res) {
  const { storeId, id } = req.params;
  const { rows } = await db.query('SELECT * FROM support_tickets WHERE id = $1 AND store_id = $2', [id, storeId]);
  if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const { rows: replies } = await db.query(
    'SELECT * FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC', [id]
  );
  res.json({ ...rows[0], replies });
}

// POST /api/stores/:storeId/support/tickets
// Reachable via a real per-user JWT (web) or the store sync key (desktop
// proxy) — see the route registration's comment in routes/stores.js.
// Only the JWT path has a per-user identity to look up server-side; the
// sync-key path (req.user.sub === null) has no such thing, so it falls
// back to trusting the name the desktop app supplied, exactly as
// cloudProxyHelpers.js's currentUserName() intended.
async function createTicket(req, res) {
  const { storeId } = req.params;
  const { subject, message, priority, createdByName } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });

  let resolvedName = createdByName || null;
  if (req.user.sub) {
    const { rows: userRows } = await db.query('SELECT name FROM users WHERE id = $1', [req.user.sub]);
    resolvedName = userRows[0]?.name || resolvedName;
  }

  const { rows } = await db.query(
    `INSERT INTO support_tickets (store_id, subject, message, priority, created_by_name)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [storeId, subject, message, priority || 'normal', resolvedName]
  );
  const ticket = rows[0];

  if (SUPPORT_INBOX_EMAIL) {
    sendMail({
      to: SUPPORT_INBOX_EMAIL,
      subject: `[SAFE Stores Support] New ticket: ${subject}`,
      text: `Store: ${storeId}\nPriority: ${ticket.priority}\n\n${message}`,
    });
  }

  res.status(201).json(ticket);
}

// POST /api/stores/:storeId/support/tickets/:id/reply  (store-side reply)
// Reachable via a real per-user JWT (web) or the store sync key (desktop
// proxy) — same dual-mode reasoning as createTicket above. author_id has
// no FK constraint (see migration 013's header — a reply's author is
// either a store user or a super admin, two different tables), so it's
// left null regardless of auth mode; only author_name differs by mode.
async function addReply(req, res) {
  const { storeId, id } = req.params;
  const { message, authorName } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const { rows: ticketRows } = await db.query(
    'SELECT * FROM support_tickets WHERE id = $1 AND store_id = $2', [id, storeId]
  );
  if (!ticketRows[0]) return res.status(404).json({ error: 'Ticket not found' });

  let resolvedName = authorName || 'Store user';
  if (req.user.sub) {
    const { rows: userRows } = await db.query('SELECT name FROM users WHERE id = $1', [req.user.sub]);
    resolvedName = userRows[0]?.name || resolvedName;
  }

  const { rows } = await db.query(
    `INSERT INTO support_ticket_replies (ticket_id, author_type, author_id, author_name, message)
     VALUES ($1,'store_user',NULL,$2,$3) RETURNING *`,
    [id, resolvedName, message]
  );
  await db.query(
    `UPDATE support_tickets SET status = 'open', updated_at = now() WHERE id = $1`, [id]
  );

  if (SUPPORT_INBOX_EMAIL) {
    sendMail({
      to: SUPPORT_INBOX_EMAIL,
      subject: `[SAFE Stores Support] New reply on: ${ticketRows[0].subject}`,
      text: message,
    });
  }

  res.status(201).json(rows[0]);
}

// ---- Super Admin side ----

// GET /api/super/support/tickets?status=open
async function listAllTicketsSuper(req, res) {
  const { status } = req.query;
  const { rows } = status
    ? await db.query(
        `SELECT t.*, s.name AS store_name FROM support_tickets t
         JOIN stores s ON s.id = t.store_id WHERE t.status = $1 ORDER BY t.updated_at DESC`,
        [status]
      )
    : await db.query(
        `SELECT t.*, s.name AS store_name FROM support_tickets t
         JOIN stores s ON s.id = t.store_id ORDER BY t.updated_at DESC`
      );
  res.json(rows);
}

// GET /api/super/support/tickets/:id
async function getTicketSuper(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `SELECT t.*, s.name AS store_name FROM support_tickets t
     JOIN stores s ON s.id = t.store_id WHERE t.id = $1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  const { rows: replies } = await db.query(
    'SELECT * FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC', [id]
  );
  res.json({ ...rows[0], replies });
}

// PATCH /api/super/support/tickets/:id   { status }
async function updateTicketStatusSuper(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { rows } = await db.query(
    `UPDATE support_tickets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`, [status, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
  emitToStore(rows[0].store_id, 'support_ticket:updated', rows[0]);
  res.json(rows[0]);
}

// POST /api/super/support/tickets/:id/reply
async function addReplySuper(req, res) {
  const { id } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const { rows: ticketRows } = await db.query('SELECT * FROM support_tickets WHERE id = $1', [id]);
  if (!ticketRows[0]) return res.status(404).json({ error: 'Ticket not found' });

  const { rows: adminRows } = await db.query('SELECT name FROM super_admins WHERE id = $1', [req.user.sub]);
  const { rows } = await db.query(
    `INSERT INTO support_ticket_replies (ticket_id, author_type, author_id, author_name, message)
     VALUES ($1,'super_admin',$2,$3,$4) RETURNING *`,
    [id, req.user.sub, adminRows[0]?.name || 'Support team', message]
  );
  await db.query(`UPDATE support_tickets SET status = 'in_progress', updated_at = now() WHERE id = $1`, [id]);

  emitToStore(ticketRows[0].store_id, 'support_ticket:replied', { ticketId: id, reply: rows[0] });
  sendPushToStore(ticketRows[0].store_id, {
    title: 'Support replied to your ticket',
    body: message.length > 120 ? `${message.slice(0, 117)}...` : message,
    data: { type: 'support_ticket.replied', ticketId: id },
  });
  dispatchEvent(ticketRows[0].store_id, 'support_ticket.replied', { ticketId: id, message });

  res.status(201).json(rows[0]);
}

module.exports = {
  listMyTickets, getTicket, createTicket, addReply,
  listAllTicketsSuper, getTicketSuper, updateTicketStatusSuper, addReplySuper,
};

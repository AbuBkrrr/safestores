// ------------------------------------------------------------
// Support tickets — talking to the Super Admin support queue. This is
// inherently cloud-side (the Super Admin's queue lives there), so this is
// a thin proxy, same pattern as marketplaceController.js. The local
// admin's name is looked up here and passed along, since the cloud has no
// way to know it — see cloudProxyHelpers.js.
// ------------------------------------------------------------

const axios = require('axios');
const db = require('../db');
const { cloudClientOrError, currentUserName, forwardError } = require('./cloudProxyHelpers');
const { dispatchEvent } = require('../utils/webhooks');

// GET /api/stores/:storeId/support/tickets
async function listMyTickets(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/support/tickets`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// GET /api/stores/:storeId/support/tickets/:id
// Also the point where a Super Admin reply gets noticed and turned into a
// 'support_ticket.replied' webhook — there's no push channel from the
// cloud back to this device, so detecting it here (whenever the ticket is
// viewed/polled) is the natural hook. A small local marker table prevents
// re-firing for a reply already dispatched once.
async function getTicket(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/support/tickets/${req.params.id}`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);

    const latestAdminReply = [...(data.replies || [])].reverse().find((r) => r.author_type === 'super_admin');
    if (latestAdminReply) {
      const marker = db.prepare('SELECT last_reply_id FROM webhook_ticket_markers WHERE ticket_id = ?').get(req.params.id);
      if (!marker || marker.last_reply_id !== latestAdminReply.id) {
        db.prepare(
          'INSERT INTO webhook_ticket_markers (ticket_id, last_reply_id) VALUES (?,?) ON CONFLICT (ticket_id) DO UPDATE SET last_reply_id = excluded.last_reply_id'
        ).run(req.params.id, latestAdminReply.id);
        dispatchEvent(cloud.storeId, 'support_ticket.replied', { ticketId: req.params.id, message: latestAdminReply.message });
      }
    }
  } catch (err) { forwardError(err, res); }
}

// POST /api/stores/:storeId/support/tickets
async function createTicket(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.post(
      `${cloud.baseUrl}/api/stores/${cloud.storeId}/support/tickets`,
      { ...req.body, createdByName: currentUserName(req) },
      { headers: cloud.headers, timeout: 10000 }
    );
    res.status(201).json(data);
    dispatchEvent(cloud.storeId, 'support_ticket.created', { ticketId: data.id, subject: data.subject, priority: data.priority });
  } catch (err) { forwardError(err, res); }
}

// POST /api/stores/:storeId/support/tickets/:id/reply
async function addReply(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.post(
      `${cloud.baseUrl}/api/stores/${cloud.storeId}/support/tickets/${req.params.id}/reply`,
      { ...req.body, authorName: currentUserName(req) },
      { headers: cloud.headers, timeout: 10000 }
    );
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

module.exports = { listMyTickets, getTicket, createTicket, addReply };

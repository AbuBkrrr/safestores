// Marketing: tracking links (QR codes / share links per channel), who opened
// them — same device coming back vs. the link reaching new people — leads
// from the website form, sign-ups each link brought, and outreach.
const crypto = require('crypto');
const db = require('../config/db');
const { parseUserAgent, countryOf } = require('../utils/userAgent');
const { sendMail } = require('../utils/mailer');

const CHANNELS = ['whatsapp', 'facebook', 'instagram', 'tiktok', 'x', 'linkedin', 'telegram', 'youtube', 'email', 'sms', 'flyer', 'poster', 'event', 'radio', 'partner', 'other'];
const clip = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
const codeOk = (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(c);
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
// Where links point: Super Admin's setting (Marketing → Link address), else the server's settings.
let cache = null; let cacheAt = 0;
async function urls() {
  if (!cache || Date.now() - cacheAt > 30000) {
    cache = (await db.query("SELECT link_base, landing_url, signup_url FROM marketing_settings WHERE id = 'default'").catch(() => ({ rows: [] }))).rows[0] || {};
    cacheAt = Date.now();
  }
  const app = trimUrl(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL?.split(',')[0] || 'https://app.safestore.com.ng');
  return {
    base: trimUrl(cache.link_base) || app,
    landing: `${trimUrl(cache.landing_url || process.env.MARKETING_LANDING_URL || 'https://safestore.com.ng')}/`,
    signup: trimUrl(cache.signup_url) || `${trimUrl(cache.link_base) || app}/signup`,
  };
}

// ---------------------------------------------------------------- public

// GET /go/:code — what a QR code / short link points at.
async function go(req, res) {
  const code = codeOk(req.params.code) ? req.params.code : null;
  const link = code && (await db.query('SELECT code, target FROM marketing_links WHERE code = $1', [code])).rows[0];
  const qs = link ? `ref=${encodeURIComponent(link.code)}` : '';
  const u = await urls();
  if (link?.target === 'signup') return res.redirect(302, `${u.signup}?${qs}`);
  res.redirect(302, `${u.landing}${qs ? `?${qs}` : ''}`);
}

// POST /api/m/open — the page reports it was opened. body: { ref, deviceId, signature, tz, lang, screen, referrer, page, utm }
async function recordOpen(req, res) {
  const b = req.body || {};
  const ref = codeOk(b.ref) ? b.ref : null;
  const id = typeof b.deviceId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.deviceId) ? b.deviceId : null;
  const sig = typeof b.signature === 'string' ? crypto.createHash('sha256').update(b.signature).digest('hex').slice(0, 32) : null;
  const deviceKey = id || (sig && `sig:${sig}`);
  if (!deviceKey) return res.status(400).json({ error: 'Missing device' });
  const ua = parseUserAgent(req.headers['user-agent']);
  if (ua.deviceType === 'bot') return res.json({ ignored: true });
  const tz = clip(b.tz, 60);
  const place = countryOf(req, tz);
  const utm = b.utm || {};

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // One link (or "no label") at a time, so device numbers never clash.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mk:${ref || ''}`]);
    const prior = (await client.query(
      `SELECT device_no, MAX(open_no) AS opens FROM marketing_opens WHERE link_code IS NOT DISTINCT FROM $1 AND device_key = $2 GROUP BY device_no`,
      [ref, deviceKey])).rows[0];
    const deviceNo = prior ? prior.device_no
      : Number((await client.query('SELECT COALESCE(MAX(device_no), 0) + 1 AS n FROM marketing_opens WHERE link_code IS NOT DISTINCT FROM $1', [ref])).rows[0].n);
    const openNo = prior ? Number(prior.opens) + 1 : 1;
    await client.query(
      `INSERT INTO marketing_opens (link_code, device_key, device_key_kind, device_no, open_no, device_type, os, browser, model, in_app,
        country, country_code, timezone, language, screen, referrer, page, utm_source, utm_medium, utm_campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [ref, deviceKey, id ? 'id' : 'signature', deviceNo, openNo, ua.deviceType, ua.os, ua.browser, clip(ua.model, 80), ua.inApp,
        place.country, place.countryCode, tz, clip(b.lang, 20), clip(b.screen, 20), clip(b.referrer, 300), clip(b.page, 60),
        clip(utm.source, 60), clip(utm.medium, 60), clip(utm.campaign, 80)]);
    await client.query('COMMIT');
    res.json({ deviceNo, openNo, newDevice: openNo === 1 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

// POST /api/m/lead — the website's "talk to us" form.
async function recordLead(req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = clip(String(b.phone || '').trim(), 40);
  const email = clip(String(b.email || '').trim().toLowerCase(), 160);
  if (!name || (!phone && !email)) return res.status(400).json({ error: 'Your name and a phone number or email are needed' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Check the email address' });
  const tz = clip(b.tz, 60);
  const deviceKey = typeof b.deviceId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.deviceId) ? b.deviceId : null;
  const { rows } = await db.query(
    `INSERT INTO marketing_leads (link_code, device_key, name, phone, email, shop, topic, message, country, language, consent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [codeOk(b.ref) ? b.ref : null, deviceKey, name.slice(0, 120), phone, email, clip(b.shop, 160), clip(b.topic, 30), clip(b.message, 2000),
      countryOf(req, tz).country, clip(b.lang, 20), b.consent === true]);
  if (process.env.SUPPORT_INBOX_EMAIL) {
    sendMail({ to: process.env.SUPPORT_INBOX_EMAIL, subject: `[SAFE Stores] New lead: ${name}${b.shop ? ` (${b.shop})` : ''}`,
      text: `Name: ${name}\nPhone: ${phone || '-'}\nEmail: ${email || '-'}\nShop: ${b.shop || '-'}\nWants: ${b.topic || '-'}\n\n${b.message || ''}\n\nSee Super Admin → Marketing → Leads.` });
  }
  res.status(201).json({ id: rows[0].id });
}

// GET /api/m/unsubscribe/:token
async function unsubscribe(req, res) {
  await db.query('UPDATE marketing_leads SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE unsubscribe_token = $1', [String(req.params.token).slice(0, 40)]);
  res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>You are unsubscribed</h2><p>You will not get any more emails from SAFE Stores.</p></body>');
}

// ---------------------------------------------------------------- super admin

function verdict(opens, devices) {
  if (!opens) return 'Not opened yet';
  if (devices <= 1) return `1 device, opened ${opens}×`;
  return `Shared · ${devices} devices`;
}

const LINK_STATS = `
  SELECT l.*, COALESCE(o.opens, 0)::int AS opens, COALESCE(o.devices, 0)::int AS devices,
         COALESCE(o.opens, 0)::int - COALESCE(o.devices, 0)::int AS repeat_opens, o.last_open,
         (SELECT COUNT(*) FROM marketing_leads ml WHERE ml.link_code = l.code)::int AS leads,
         (SELECT COUNT(*) FROM stores s WHERE s.ref_code = l.code)::int AS signups,
         (SELECT COUNT(*) FROM stores s WHERE s.ref_code = l.code AND s.subscription_status = 'active')::int AS active_stores
  FROM marketing_links l
  LEFT JOIN (SELECT link_code, COUNT(*) AS opens, COUNT(DISTINCT device_key) AS devices, MAX(created_at) AS last_open
             FROM marketing_opens GROUP BY link_code) o ON o.link_code = l.code`;

async function listLinks(req, res) {
  const { rows } = await db.query(`${LINK_STATS} WHERE l.archived_at IS NULL ORDER BY l.created_at DESC`);
  // Opens that came with no tracking link at all.
  const none = (await db.query(`SELECT COUNT(*)::int AS opens, COUNT(DISTINCT device_key)::int AS devices, MAX(created_at) AS last_open
    FROM marketing_opens WHERE link_code IS NULL OR link_code NOT IN (SELECT code FROM marketing_links)`)).rows[0];
  const { base } = await urls();
  const out = rows.map((l) => ({ ...l, url: `${base}/go/${l.code}`, verdict: verdict(l.opens, l.devices) }));
  if (none.opens) out.push({ id: null, code: null, label: '(no label)', channel: 'direct', ...none, repeat_opens: none.opens - none.devices, leads: 0, signups: 0, active_stores: 0, verdict: verdict(none.opens, none.devices) });
  res.json(out);
}

async function createLink(req, res) {
  const label = String(req.body?.label || '').trim().slice(0, 120);
  const channel = CHANNELS.includes(req.body?.channel) ? req.body.channel : 'other';
  const target = req.body?.target === 'signup' ? 'signup' : 'landing';
  if (!label) return res.status(400).json({ error: 'Give the link a name, e.g. "Flyer – Kano market"' });
  for (let i = 0; i < 5; i += 1) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
    if (code.length < 6) continue;
    try {
      const { rows } = await db.query('INSERT INTO marketing_links (code, label, channel, target, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [code, label, channel, target, req.user.sub]);
      return res.status(201).json({ ...rows[0], url: `${(await urls()).base}/go/${code}` });
    } catch (err) { if (err.code !== '23505') throw err; }
  }
  res.status(500).json({ error: 'Could not make a link code, try again' });
}

async function archiveLink(req, res) {
  await db.query('UPDATE marketing_links SET archived_at = now() WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}

// GET /api/super/marketing/opens?link=<code|none>&limit=
async function listOpens(req, res) {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const params = [limit];
  let where = '';
  if (req.query.link === 'none') where = 'WHERE o.link_code IS NULL';
  else if (codeOk(req.query.link)) { params.push(req.query.link); where = 'WHERE o.link_code = $2'; }
  const { rows } = await db.query(
    `SELECT o.id, o.link_code, COALESCE(l.label, '(no label)') AS label, o.device_no, o.open_no, o.device_key_kind,
            o.device_type, o.os, o.browser, o.model, o.in_app, o.country, o.timezone, o.language, o.screen, o.referrer, o.created_at
     FROM marketing_opens o LEFT JOIN marketing_links l ON l.code = o.link_code ${where}
     ORDER BY o.created_at DESC LIMIT $1`, params);
  res.json(rows);
}

// GET /api/super/marketing/overview?days=30
async function overview(req, res) {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = `now() - interval '${days} days'`;
  const q = async (sql) => (await db.query(sql)).rows;
  const [totals] = await q(`SELECT COUNT(*)::int AS opens, COUNT(DISTINCT device_key)::int AS devices,
      (COUNT(*) - COUNT(DISTINCT (COALESCE(link_code, ''), device_key)))::int AS repeat_opens,
      COUNT(DISTINCT country)::int AS countries FROM marketing_opens WHERE created_at > ${since}`);
  const [funnel] = await q(`SELECT
      (SELECT COUNT(*) FROM marketing_leads WHERE created_at > ${since})::int AS leads,
      (SELECT COUNT(*) FROM stores WHERE created_at > ${since})::int AS signups,
      (SELECT COUNT(*) FROM stores WHERE created_at > ${since} AND ref_code IS NOT NULL)::int AS tracked_signups,
      (SELECT COUNT(*) FROM stores WHERE created_at > ${since} AND subscription_status = 'active')::int AS activated`);
  const by = (col) => q(`SELECT COALESCE(${col}, 'Unknown') AS name, COUNT(*)::int AS opens, COUNT(DISTINCT device_key)::int AS devices
      FROM marketing_opens WHERE created_at > ${since} GROUP BY 1 ORDER BY devices DESC, opens DESC LIMIT 12`);
  const [countries, devices, systems, sources, languages] = await Promise.all([
    by('country'), by('device_type'), by('os'), by(`COALESCE(in_app, utm_source, CASE WHEN referrer IS NULL OR referrer = '' THEN 'Direct / QR' ELSE substring(referrer from '^https?://([^/]+)') END)`), by('language'),
  ]);
  const daily = await q(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS opens, COUNT(DISTINCT device_key)::int AS devices
      FROM marketing_opens WHERE created_at > ${since} GROUP BY 1 ORDER BY 1`);
  const hours = await q(`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS opens FROM marketing_opens WHERE created_at > ${since} GROUP BY 1 ORDER BY 1`);
  res.json({ days, totals: { ...totals, ...funnel }, countries, devices, systems, sources, languages, daily, hours });
}

async function listLeads(req, res) {
  const { rows } = await db.query(
    `SELECT ml.id, ml.link_code, COALESCE(l.label, '(no label)') AS label, ml.name, ml.phone, ml.email, ml.shop, ml.topic, ml.message,
            ml.country, ml.language, ml.consent, ml.status, ml.notes, ml.unsubscribed_at, ml.last_contacted_at, ml.created_at,
            (SELECT COUNT(*) FROM marketing_opens o WHERE o.device_key = ml.device_key)::int AS device_opens
     FROM marketing_leads ml LEFT JOIN marketing_links l ON l.code = ml.link_code
     ORDER BY ml.created_at DESC LIMIT 1000`);
  res.json(rows);
}

async function updateLead(req, res) {
  const status = ['new', 'contacted', 'registered', 'not_interested'].includes(req.body?.status) ? req.body.status : null;
  const notes = req.body?.notes !== undefined ? clip(req.body.notes, 2000) : undefined;
  const { rows } = await db.query(
    `UPDATE marketing_leads SET status = COALESCE($1, status), notes = CASE WHEN $2::boolean THEN $3 ELSE notes END,
       last_contacted_at = CASE WHEN $4::boolean THEN now() ELSE last_contacted_at END, updated_at = now()
     WHERE id = $5 RETURNING id, status, notes, last_contacted_at`,
    [status, notes !== undefined, notes ?? null, req.body?.contacted === true, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
  res.json(rows[0]);
}

async function exportLeads(req, res) {
  const { rows } = await db.query('SELECT name, phone, email, shop, topic, country, language, status, consent, created_at, message FROM marketing_leads ORDER BY created_at DESC');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['name', 'phone', 'email', 'shop', 'topic', 'country', 'language', 'status', 'consent', 'created_at', 'message'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="safestores-leads.csv"');
  res.send([head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
}

// POST /api/super/marketing/outreach/email  { leadIds, subject, body }  — {{name}} and {{shop}} are filled in.
// Only leads who agreed to be contacted, have an email, and have not unsubscribed.
async function emailLeads(req, res) {
  const ids = Array.isArray(req.body?.leadIds) ? req.body.leadIds.slice(0, 500).map(String) : [];
  const subject = String(req.body?.subject || '').trim().slice(0, 150);
  const body = String(req.body?.body || '').trim().slice(0, 5000);
  if (!ids.length || !subject || !body) return res.status(400).json({ error: 'Choose leads and write a subject and message' });
  const { rows } = await db.query(
    `SELECT id, name, shop, email, unsubscribe_token FROM marketing_leads
     WHERE id::text = ANY($1) AND consent AND email IS NOT NULL AND unsubscribed_at IS NULL`, [ids]);
  const u = await urls();
  const api = u.base;
  for (const l of rows) {
    const text = body.replace(/\{\{\s*name\s*\}\}/g, l.name || '').replace(/\{\{\s*shop\s*\}\}/g, l.shop || 'your shop').replace(/\{\{\s*signup\s*\}\}/g, u.signup)
      + `\n\n—\nYou are getting this because you asked SAFE Stores to contact you. Unsubscribe: ${api}/api/m/unsubscribe/${l.unsubscribe_token}`;
    sendMail({ to: l.email, subject, text });
  }
  if (rows.length) await db.query(`UPDATE marketing_leads SET last_contacted_at = now(), status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  res.json({ sent: rows.length, skipped: ids.length - rows.length });
}

// GET/PUT /api/super/marketing/settings  { linkBase, landingUrl, signupUrl }
async function getSettings(req, res) {
  cache = null;
  const u = await urls();
  res.json({ linkBase: cache.link_base || '', landingUrl: cache.landing_url || '', signupUrl: cache.signup_url || '', effective: u });
}
async function saveSettings(req, res) {
  const clean = (v) => {
    const s = trimUrl(v);
    if (!s) return null;
    if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/[^\s]*)?$/i.test(s)) throw Object.assign(new Error(`Check the address: ${s}`), { status: 400 });
    return s;
  };
  let vals;
  try { vals = [clean(req.body?.linkBase), clean(req.body?.landingUrl), clean(req.body?.signupUrl)]; } catch (err) { return res.status(400).json({ error: err.message }); }
  await db.query(`INSERT INTO marketing_settings (id, link_base, landing_url, signup_url, updated_at) VALUES ('default', $1, $2, $3, now())
    ON CONFLICT (id) DO UPDATE SET link_base = $1, landing_url = $2, signup_url = $3, updated_at = now()`, vals);
  cache = null;
  return getSettings(req, res);
}

module.exports = { getSettings, saveSettings, go, recordOpen, recordLead, unsubscribe, listLinks, createLink, archiveLink, listOpens, overview, listLeads, updateLead, exportLeads, emailLeads, CHANNELS };

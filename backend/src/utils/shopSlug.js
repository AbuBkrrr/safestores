// Custom storefront addresses: /shop/<slug>. A slug is 3–40 chars of
// lowercase letters, digits and single hyphens, and can't be a UUID or a
// reserved word, so it never collides with /shop/<store id> links.
const db = require('../config/db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED = new Set(['admin', 'api', 'app', 'shop', 'share', 'login', 'signup', 'super', 'marketplace', 'track', 'safestores', 'support', 'help']);

/** Returns { value } (normalised slug, or null to clear) or { error }. */
function parseShopSlug(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null };
  const s = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) || s.length < 3 || s.length > 40) {
    return { error: 'Shop address must be 3–40 letters or numbers, with single hyphens between words (e.g. mama-ngozi-lekki)' };
  }
  if (UUID.test(s) || RESERVED.has(s)) return { error: 'That shop address is reserved — please pick another' };
  return { value: s };
}

/** A store id or a slug → the store id (or null). */
async function resolveShopId(param) {
  if (!param) return null;
  if (UUID.test(param)) return param;
  const { rows } = await db.query('SELECT id FROM stores WHERE shop_slug = $1', [String(param).toLowerCase()]);
  return rows[0]?.id || null;
}

/** Express param handler: lets any :storeId on public shop routes be a slug. */
async function shopParam(req, res, next, value) {
  try {
    const id = await resolveShopId(value);
    if (!id) return res.status(404).json({ error: 'Store not found' });
    req.params.storeId = id;
    next();
  } catch (err) { next(err); }
}

module.exports = { parseShopSlug, resolveShopId, shopParam, UUID };

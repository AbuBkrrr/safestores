const db = require('../config/db');

const SUPPORTED_CODES = ['NGN', 'GHS', 'KES', 'ZAR', 'XOF', 'USD', 'GBP', 'EUR'];

// GET /api/settings/currency — deliberately public, no requireAuth (see
// server.js): a currency code/symbol isn't sensitive, and the public
// customer Storefront needs this too, not just logged-in admin pages.
// ?storeId= returns that store's own currency when it has set one (public
// storefronts and receipts need it without a login).
async function getCurrency(req, res) {
  const { rows } = await db.query('SELECT code, symbol FROM currency_settings WHERE id = $1', ['default']);
  const platform = rows[0] || { code: 'NGN', symbol: '₦' };
  const { storeId } = req.query;
  if (storeId && /^[0-9a-f-]{36}$/i.test(storeId)) {
    const { rows: s } = await db.query('SELECT currency_code, currency_symbol FROM stores WHERE id = $1', [storeId]);
    if (s[0]?.currency_code) return res.json({ code: s[0].currency_code, symbol: s[0].currency_symbol || s[0].currency_code });
  }
  res.json(platform);
}

// PATCH /api/super/currency  { code, symbol }
async function updateCurrency(req, res) {
  const { code, symbol } = req.body;
  if (!code || !symbol) return res.status(400).json({ error: 'code and symbol are required' });
  if (!SUPPORTED_CODES.includes(code) && !require('./storeSettingsController').symbolFor(code)) {
    return res.status(400).json({ error: `code must be one of ${SUPPORTED_CODES.join(', ')}` });
  }
  await db.query(
    `UPDATE currency_settings SET code = $1, symbol = $2, updated_at = now() WHERE id = 'default'`,
    [code, symbol]
  );
  const { rows } = await db.query('SELECT code, symbol FROM currency_settings WHERE id = $1', ['default']);
  res.json(rows[0]);
}

module.exports = { getCurrency, updateCurrency };

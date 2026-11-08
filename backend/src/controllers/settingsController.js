const db = require('../config/db');

const SUPPORTED_CODES = ['NGN', 'GHS', 'KES', 'ZAR', 'XOF', 'USD', 'GBP', 'EUR'];

// GET /api/settings/currency — deliberately public, no requireAuth (see
// server.js): a currency code/symbol isn't sensitive, and the public
// customer Storefront needs this too, not just logged-in admin pages.
async function getCurrency(req, res) {
  const { rows } = await db.query('SELECT code, symbol FROM currency_settings WHERE id = $1', ['default']);
  res.json(rows[0] || { code: 'NGN', symbol: '₦' });
}

// PATCH /api/super/currency  { code, symbol }
async function updateCurrency(req, res) {
  const { code, symbol } = req.body;
  if (!code || !symbol) return res.status(400).json({ error: 'code and symbol are required' });
  if (!SUPPORTED_CODES.includes(code)) {
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

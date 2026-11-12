const db = require('../db');

const SUPPORTED_CODES = ['NGN', 'GHS', 'KES', 'ZAR', 'XOF', 'USD', 'GBP', 'EUR'];

// GET /api/settings/currency — any authenticated user (every screen that
// displays money needs this, regardless of role or store status).
function getCurrency(req, res) {
  const row = db.prepare('SELECT code, symbol FROM currency_settings WHERE id = ?').get('default');
  if (req.query.storeId) {
    const s = db.prepare('SELECT currency_code, currency_symbol FROM stores WHERE id = ?').get(req.query.storeId);
    if (s?.currency_code) return res.json({ code: s.currency_code, symbol: s.currency_symbol || s.currency_code });
  }
  res.json(row || { code: 'NGN', symbol: '₦' });
}

// PATCH /api/super/currency  { code, symbol }
function updateCurrency(req, res) {
  const { code, symbol } = req.body;
  if (!code || !symbol) return res.status(400).json({ error: 'code and symbol are required' });
  if (!SUPPORTED_CODES.includes(code)) {
    return res.status(400).json({ error: `code must be one of ${SUPPORTED_CODES.join(', ')}` });
  }
  db.prepare(
    `UPDATE currency_settings SET code = ?, symbol = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'default'`
  ).run(code, symbol);
  res.json(db.prepare('SELECT code, symbol FROM currency_settings WHERE id = ?').get('default'));
}

module.exports = { getCurrency, updateCurrency };

// ------------------------------------------------------------
// Per-store settings: currency, time zone, tax, receipt text, till rules.
// Readable by every store role (the till needs tax + currency); only an
// admin can change them.
// ------------------------------------------------------------
const db = require('../config/db');
const { logActivity } = require('../utils/activityLog');

const TIMEZONES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []);
TIMEZONES.add('UTC');

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (TIMEZONES.has(tz)) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** Narrow symbol for an ISO 4217 code via the platform's own CLDR data, e.g. 'GHS' → 'GH₵'. */
const CURRENCIES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);

function symbolFor(code) {
  // Intl will happily "format" any 3 letters, so check the real ISO list first.
  if (CURRENCIES.size && !CURRENCIES.has(code)) return null;
  try {
    const part = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((p) => p.type === 'currency');
    return part?.value || code;
  } catch { return null; }
}

const FIELDS = {
  currencyCode: 'currency_code', currencySymbol: 'currency_symbol', timezone: 'timezone',
  taxRatePct: 'tax_rate_pct', taxInclusive: 'tax_inclusive', taxLabel: 'tax_label', taxNumber: 'tax_number',
  phone: 'phone', address: 'address', city: 'city', receiptHeader: 'receipt_header', receiptFooter: 'receipt_footer',
  maxCashierDiscountPct: 'max_cashier_discount_pct', requireShift: 'require_shift', name: 'name',
};

async function readSettings(storeId) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.timezone, s.tax_rate_pct, s.tax_inclusive, s.tax_label, s.tax_number, s.phone, s.address, s.city,
            s.receipt_header, s.receipt_footer, s.max_cashier_discount_pct, s.require_shift,
            s.currency_code AS store_currency_code, s.currency_symbol AS store_currency_symbol,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = $1`,
    [storeId]
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, tax_rate_pct: Number(r.tax_rate_pct), max_cashier_discount_pct: Number(r.max_cashier_discount_pct) };
}

// GET /api/stores/:storeId/settings
async function getSettings(req, res) {
  const s = await readSettings(req.params.storeId);
  if (!s) return res.status(404).json({ error: 'Store not found' });
  res.json(s);
}

// PATCH /api/stores/:storeId/settings
async function updateSettings(req, res) {
  const { storeId } = req.params;
  const body = { ...(req.body || {}) };
  if (body.currencyCode !== undefined) {
    if (body.currencyCode === null || body.currencyCode === '') {
      body.currencyCode = null; body.currencySymbol = null; // back to the platform default
    } else {
      const code = String(body.currencyCode).toUpperCase();
      if (!/^[A-Z]{3}$/.test(code) || !symbolFor(code)) return res.status(400).json({ error: 'Unknown currency code' });
      body.currencyCode = code;
      if (!body.currencySymbol) body.currencySymbol = symbolFor(code);
    }
  }
  if (body.timezone !== undefined && !isValidTimezone(body.timezone)) return res.status(400).json({ error: 'Unknown time zone' });
  if (body.taxRatePct !== undefined) {
    const r = Number(body.taxRatePct);
    if (!(r >= 0 && r <= 100)) return res.status(400).json({ error: 'Tax rate must be between 0 and 100' });
    body.taxRatePct = r;
  }
  if (body.maxCashierDiscountPct !== undefined) {
    const r = Number(body.maxCashierDiscountPct);
    if (!(r >= 0 && r <= 100)) return res.status(400).json({ error: 'Discount limit must be between 0 and 100' });
    body.maxCashierDiscountPct = r;
  }
  if (body.name !== undefined && !String(body.name).trim()) return res.status(400).json({ error: 'Store name cannot be empty' });

  const sets = []; const values = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (['taxInclusive', 'requireShift'].includes(k)) v = !!v;
    else if (typeof v === 'string') v = v.trim().slice(0, k.startsWith('receipt') ? 500 : 160) || null;
    values.push(v); sets.push(`${col} = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(storeId);
  await db.query(`UPDATE stores SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
  const fresh = await readSettings(storeId);
  logActivity(req, { storeId, action: 'store.settings_changed', entityType: 'store', entityId: storeId, details: { fields: Object.keys(body) } });
  res.json(fresh);
}

module.exports = { getSettings, updateSettings, readSettings, isValidTimezone, symbolFor };

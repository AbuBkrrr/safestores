// ------------------------------------------------------------
// Validates rows from a spreadsheet product import (CSV/Excel parsed in
// the browser). Pure JS — desktop/server/utils/productImport.js is a copy.
// Accepts common header spellings so a shop's existing sheet usually
// imports without renaming columns.
// ------------------------------------------------------------

const ALIASES = {
  name: ['name', 'product', 'product name', 'item', 'item name', 'description'],
  sku: ['sku', 'code', 'item code', 'product code', 'ref'],
  barcode: ['barcode', 'ean', 'upc', 'gtin', 'bar code'],
  category: ['category', 'department', 'group'],
  brand: ['brand'],
  supplier: ['supplier', 'vendor'],
  unit: ['unit', 'uom', 'unit of measure'],
  costPrice: ['cost', 'cost price', 'buying price', 'purchase price', 'unit cost'],
  sellingPrice: ['price', 'selling price', 'sale price', 'retail price', 'unit price'],
  reorderLevel: ['reorder level', 'reorder', 'min stock', 'minimum'],
  openingStock: ['stock', 'quantity', 'qty', 'opening stock', 'on hand'],
  packSize: ['pack size', 'units per pack', 'units per carton', 'carton size'],
  location: ['location', 'shelf', 'bin'],
};

function clean(header) {
  return String(header || '').toLowerCase().replace(/[\u00a0_\-/():.,#*₦$€£]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Which product field a column is, from its heading. Exact names first, then
 * the words in it ("Reference Cost", "Selling Price (₦)", "Brand / Company"…).
 * Columns about prices but not a price itself ("Price Basis", "Price Source")
 * are left out. */
function canonicalKey(header) {
  const h = clean(header);
  if (!h) return null;
  for (const [key, names] of Object.entries(ALIASES)) if (names.includes(h)) return key;
  if (/\b(basis|source|url|link|note|notes|research|date|comment|remark|vat|tax|discount|margin|profit|markup|total|value)\b/.test(h)) return null;
  if (/barcode|\bean\b|\bupc\b|gtin|bar code/.test(h)) return 'barcode';
  if (/\bsku\b|item code|product code|stock code|part (no|number)/.test(h)) return 'sku';
  if (/reorder|re order|min(imum)? (stock|level|qty)/.test(h)) return 'reorderLevel';
  if (/units? per|pack size|carton size|case size/.test(h)) return 'packSize';
  if (/\bcost\b|buying|purchase|cost price|landed/.test(h)) return 'costPrice';
  if (/sell|retail|\bprice\b|\bamount\b|\brate\b/.test(h)) return 'sellingPrice';
  if (/opening|\bstock\b|\bqty\b|quantity|on hand|in stock|\bcount\b/.test(h)) return 'openingStock';
  if (/categor|department|\bgroup\b|\btype\b/.test(h)) return 'category';
  if (/brand|make|manufacturer|company/.test(h)) return 'brand';
  if (/supplier|vendor/.test(h)) return 'supplier';
  if (/\bunit\b|\buom\b/.test(h)) return 'unit';
  if (/location|shelf|\bbin\b|aisle/.test(h)) return 'location';
  if (/\bname\b|product|\bitem\b|description|title/.test(h)) return 'name';
  return null;
}

/** A SKU made from the name, the same every time — so a sheet without SKUs
 * still updates the same products when it is uploaded again. */
function skuFromName(name) {
  let h = 2166136261;
  for (const ch of String(name).trim().toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const stem = String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'ITEM';
  return `${stem}-${h.toString(36).toUpperCase().slice(0, 5)}`;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!/[0-9]/.test(cleaned)) return NaN; // e.g. "abc" or "N/A" — reject, don't read as 0
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** row: object keyed by the sheet's own headers. Returns { ok, value } or { ok: false, error }. */
function normalizeRow(row) {
  const v = {};
  for (const [h, val] of Object.entries(row || {})) {
    const k = canonicalKey(h);
    if (k && v[k] === undefined) v[k] = typeof val === 'string' ? val.trim() : val;
  }
  if (!v.name) return { ok: false, error: 'Missing product name' };
  const cost = num(v.costPrice);
  const price = num(v.sellingPrice);
  const reorder = num(v.reorderLevel);
  const stock = num(v.openingStock);
  const pack = num(v.packSize);
  for (const [label, n] of [['cost price', cost], ['selling price', price], ['reorder level', reorder], ['stock', stock], ['pack size', pack]]) {
    if (Number.isNaN(n)) return { ok: false, error: `Invalid ${label}` };
    if (n !== null && n < 0) return { ok: false, error: `${label} cannot be negative` };
  }
  // The data model prices as cost × multiplier. Derive the multiplier from
  // a selling price when given; with no cost, treat price as cost × 1.
  let costPrice = cost;
  let priceMultiplier = null;
  if (price !== null && cost !== null && cost > 0) priceMultiplier = Math.round((price / cost) * 1e10) / 1e10;
  else if (price !== null && (cost === null || cost === 0)) { costPrice = price; priceMultiplier = 1; }
  return {
    ok: true,
    value: {
      name: String(v.name).slice(0, 200),
      sku: String(v.sku || v.barcode || skuFromName(v.name)).slice(0, 60),
      barcode: v.barcode ? String(v.barcode).slice(0, 64) : null,
      category: v.category || null, brand: v.brand || null, supplier: v.supplier || null, unit: v.unit || null,
      location: v.location || null,
      costPrice, priceMultiplier,
      reorderLevel: reorder === null ? null : Math.floor(reorder),
      openingStock: stock === null ? 0 : Math.floor(stock),
      packSize: pack === null ? null : Math.max(1, Math.floor(pack)),
    },
  };
}

/** How each heading of a sheet will be read: { heading: field or null }. */
function columnMap(headers) {
  const used = new Set(); const out = {};
  for (const h of headers || []) {
    const k = canonicalKey(h);
    out[h] = k && !used.has(k) ? k : null;
    if (k) used.add(k);
  }
  return out;
}

module.exports = { normalizeRow, canonicalKey, columnMap, skuFromName, ALIASES };

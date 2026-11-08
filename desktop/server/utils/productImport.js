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

function canonicalKey(header) {
  const h = String(header || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  for (const [key, names] of Object.entries(ALIASES)) if (names.includes(h)) return key;
  return null;
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
  if (!v.sku && !v.barcode) return { ok: false, error: 'Needs a SKU or a barcode' };
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
      sku: String(v.sku || v.barcode).slice(0, 60),
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

module.exports = { normalizeRow, canonicalKey, ALIASES };

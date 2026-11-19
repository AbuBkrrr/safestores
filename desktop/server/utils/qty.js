// Quantities: whole numbers for items sold per unit; up to 3 decimals for
// products sold by weight, volume or length (1.35 kg, 0.5 litre, 2.25 yards).
const FRACTIONAL = new Set(['weight', 'volume', 'length']);

const roundQty = (v) => Math.round(Number(v) * 1000) / 1000;

/** Parses a quantity for `product`; returns { value } or { error }. */
function parseQty(raw, product, { allowZero = false } = {}) {
  const n = roundQty(raw);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return { error: 'Quantity must be more than 0' };
  if (!(product && FRACTIONAL.has(product.sold_by)) && !Number.isInteger(n)) {
    return { error: `${product?.name || 'This item'} is sold in whole units` };
  }
  return { value: n };
}

module.exports = { parseQty, roundQty, FRACTIONAL };

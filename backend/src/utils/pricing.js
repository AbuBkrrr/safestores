// ------------------------------------------------------------
// Order money maths — pure functions, shared verbatim by the cloud and
// desktop editions (desktop/server/utils/pricing.js is a copy; keep them
// identical). All amounts are rounded to 2 decimal places at each step
// that a customer would see on a receipt.
//
//   subtotal  = Σ line totals
//   discount  = percent of subtotal, or a fixed amount (never > subtotal)
//   base      = subtotal − discount
//   tax       = inclusive: base × r/(100+r)   (already inside the price)
//               exclusive: base × r/100       (added on top)
//   total     = inclusive: base               exclusive: base + tax
// ------------------------------------------------------------

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computeTotals({ subtotal, discountType = null, discountValue = 0, taxRatePct = 0, taxInclusive = true }) {
  const sub = r2(subtotal || 0);
  let discount = 0;
  if (discountType === 'percent') discount = r2(sub * Math.min(Math.max(Number(discountValue) || 0, 0), 100) / 100);
  else if (discountType === 'amount') discount = r2(Math.min(Math.max(Number(discountValue) || 0, 0), sub));
  const base = r2(sub - discount);
  const rate = Math.max(Number(taxRatePct) || 0, 0);
  const tax = rate === 0 ? 0 : (taxInclusive ? r2(base * rate / (100 + rate)) : r2(base * rate / 100));
  const total = taxInclusive ? base : r2(base + tax);
  return { subtotal: sub, discountAmount: discount, taxAmount: tax, total };
}

/** Effective discount as a % of subtotal — what approval limits compare against. */
function discountPercentOf({ subtotal, discountType, discountValue }) {
  const sub = Number(subtotal) || 0;
  if (!discountType || sub <= 0) return 0;
  if (discountType === 'percent') return Number(discountValue) || 0;
  return (Math.min(Number(discountValue) || 0, sub) / sub) * 100;
}

/** Refund value for `qty` units of a line: its share of what the customer
 * actually paid (order discounts and any exclusive tax spread pro rata). */
function refundAmountFor({ lineTotal, lineQty, qty, orderSubtotal, orderTotal }) {
  if (!lineQty || !orderSubtotal) return 0;
  const factor = Number(orderTotal) / Number(orderSubtotal);
  return r2((Number(lineTotal) / Number(lineQty)) * qty * factor);
}

/**
 * Validates a list of tenders against an order total.
 * payments: [{ method, amount, reference?, storeCustomerId? }]
 * Only cash may exceed what's owed (the excess is change). Returns
 * { ok, error?, applied: [{...payment, amount: appliedAmount}], tendered, change }.
 */
const METHODS = ['cash', 'card', 'transfer', 'mobile_money', 'credit', 'other'];
function allocatePayments(total, payments) {
  const due = r2(total);
  if (!Array.isArray(payments) || payments.length === 0) return { ok: false, error: 'At least one payment is required' };
  for (const p of payments) {
    if (!METHODS.includes(p.method)) return { ok: false, error: `Unknown payment method: ${p.method}` };
    if (!(Number(p.amount) > 0)) return { ok: false, error: 'Each payment amount must be more than zero' };
  }
  const tendered = r2(payments.reduce((s, p) => s + Number(p.amount), 0));
  const nonCash = r2(payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + Number(p.amount), 0));
  if (nonCash > due) return { ok: false, error: 'Card, transfer and credit payments cannot be more than the amount due' };
  if (tendered + 0.001 < due) return { ok: false, error: `Payments are short by ${r2(due - tendered).toFixed(2)}` };
  const change = r2(tendered - due);
  // Cash absorbs the change: reduce cash entries (largest first) by the change.
  let remainingChange = change;
  const applied = payments.map((p) => ({ ...p, amount: r2(p.amount) }));
  for (const p of [...applied].filter((x) => x.method === 'cash').sort((a, b) => b.amount - a.amount)) {
    if (remainingChange <= 0) break;
    const take = Math.min(p.amount, remainingChange);
    p.amount = r2(p.amount - take);
    remainingChange = r2(remainingChange - take);
  }
  return { ok: true, applied: applied.filter((p) => p.amount > 0), tendered, change };
}

module.exports = { r2, computeTotals, discountPercentOf, refundAmountFor, allocatePayments, PAYMENT_METHODS: METHODS };

// ------------------------------------------------------------
// Expiry & Batch Tracking calculations.
//
// Batches don't store a "remaining quantity" column (see the migration's
// header for why) — this walks a product's batches oldest-expiry-first
// and allocates that product's total sale+damage+expiry consumption
// across them in that order. That's what "FIFO" means here: whichever
// batch expires soonest is treated as the one being sold down first,
// which is both the sensible physical practice and the only ordering
// that makes "prioritize this batch before it expires" meaningful.
//
// This is an approximation, not a perfect ledger — it doesn't know which
// specific movement drew from which specific batch, only the running
// total. That's fine for its purpose (deciding what to discount/alert on
// soon), and it costs nothing at every other stock-movement call site.
// ------------------------------------------------------------

/**
 * @param {Array<{id, expiryDate: string, quantityReceived: number}>} batches
 *   Must belong to a single product, any order — this sorts them itself.
 * @param {number} totalConsumed - that product's SUM(sale+damage+expiry) quantity, all-time
 * @returns {Array<{id, expiryDate, quantityReceived, remaining}>} same batches, oldest-expiry first, with remaining computed
 */
function allocateFifoRemaining(batches, totalConsumed) {
  const sorted = [...batches].sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  let left = totalConsumed;
  return sorted.map((b) => {
    const consumedFromThis = Math.min(b.quantityReceived, Math.max(left, 0));
    left -= consumedFromThis;
    return { ...b, remaining: b.quantityReceived - consumedFromThis };
  });
}

/**
 * Suggested markdown as a batch's expiry approaches — steeper the closer
 * it gets, so near-worthless stock has a shot at selling instead of
 * becoming a total write-off. Deliberately simple fixed bands rather than
 * a formula — easy for a store owner to reason about and override.
 *
 * The default bands assume shelf-stable packaged goods, where "expiring
 * in 2 weeks" is a heads-up, not an emergency. That's much too slow for
 * genuinely perishable goods — fresh dairy, produce, and especially ice
 * cream/frozen items can go from fine to a write-off in days, sometimes
 * hours. `storageType` (a product's `storage_type` column — see
 * 025_perishable_storage_type.sql) switches to a compressed same-scale
 * curve for 'refrigerated'/'frozen': the exact discount percentages are
 * unchanged, they just trigger at day counts roughly a third of the
 * ambient bands, since that's proportionate to how much faster these
 * goods actually spoil.
 *
 * @param {number} daysUntilExpiry - negative if already expired
 * @param {'ambient'|'refrigerated'|'frozen'} [storageType='ambient']
 * @returns {number|null} suggested discount percent, or null if too far out to act on yet
 */
function suggestedDiscountPct(daysUntilExpiry, storageType = 'ambient') {
  if (daysUntilExpiry < 0) return null; // already expired — this is a write-off/removal decision, not a markdown one

  if (storageType === 'refrigerated' || storageType === 'frozen') {
    if (daysUntilExpiry <= 1) return 50;
    if (daysUntilExpiry <= 2) return 30;
    if (daysUntilExpiry <= 5) return 15;
    if (daysUntilExpiry <= 10) return 5;
    return null;
  }

  if (daysUntilExpiry <= 3) return 50;
  if (daysUntilExpiry <= 7) return 30;
  if (daysUntilExpiry <= 14) return 15;
  if (daysUntilExpiry <= 30) return 5;
  return null; // far enough out that no action is needed yet
}

/**
 * How far ahead to even bother looking for a given storage type — used by
 * both the on-demand "expiring soon" list and the daily alert sweep, so
 * a frozen product 25 days out (irrelevant — it'll get its own alert
 * later, closer to the date) doesn't drown out the ambient products that
 * genuinely need attention at that range right now.
 * @param {'ambient'|'refrigerated'|'frozen'} [storageType='ambient']
 */
function alertWindowDays(storageType = 'ambient') {
  return storageType === 'refrigerated' || storageType === 'frozen' ? 10 : 30;
}

function daysUntil(dateStr) {
  const ms = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

module.exports = { allocateFifoRemaining, suggestedDiscountPct, alertWindowDays, daysUntil };

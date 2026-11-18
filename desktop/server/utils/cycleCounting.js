// ------------------------------------------------------------
// Cycle Counting & Inventory Accuracy — risk scoring.
//
// "Automates count scheduling" means picking a small, sensible daily list
// automatically, not counting everything constantly. A product's risk
// score combines three signals, each answering a different question:
//   - value at stake: cost_price * (shelf_qty + backroom_qty) — losing
//     track of 2 units of something expensive matters more than 2 units
//     of something cheap
//   - recent discrepancy history: a product that's been wrong before is
//     more likely to be wrong again (shrinkage, miscounts, theft pattern)
//   - staleness: how long since it was last counted at all — even a
//     low-value, no-history product should get checked eventually
// ------------------------------------------------------------

const HIGH_VALUE_THRESHOLD = 5000; // store-currency units at stake
const MEDIUM_VALUE_THRESHOLD = 1000;

const RECOUNT_CADENCE_DAYS = { high: 14, medium: 30, low: 60 };

/**
 * @param {number} valueAtStake - cost_price * total on-hand qty
 * @param {number} recentDiscrepancyCount - count of non-zero-discrepancy cycle counts in the last 90 days
 * @param {number|null} daysSinceLastCount - null if never counted
 * @returns {'high'|'medium'|'low'}
 */
function riskTier(valueAtStake, recentDiscrepancyCount, daysSinceLastCount) {
  let score = 0;
  if (valueAtStake >= HIGH_VALUE_THRESHOLD) score += 2;
  else if (valueAtStake >= MEDIUM_VALUE_THRESHOLD) score += 1;

  if (recentDiscrepancyCount >= 2) score += 2;
  else if (recentDiscrepancyCount >= 1) score += 1;

  if (daysSinceLastCount === null || daysSinceLastCount >= 60) score += 2;
  else if (daysSinceLastCount >= 30) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function dueDateForTier(tier) {
  const days = RECOUNT_CADENCE_DAYS[tier];
  const d = new Date();
  d.setDate(d.getDate() + Math.round(days / 4)); // due within the first quarter of the cadence window, not the full window
  return d.toISOString().slice(0, 10);
}

module.exports = { riskTier, dueDateForTier, RECOUNT_CADENCE_DAYS };

// ------------------------------------------------------------
// Smart Replenishment calculations.
//
// This is a deliberately simple, explainable heuristic — NOT a forecasting
// model. It answers three questions per product from real sales history:
//   1. How fast is this actually selling right now? (velocity)
//   2. Is that trending up or down vs the period before? (seasonal nudge)
//   3. Given that, and how long a reorder takes to arrive (lead time),
//      what stock level should trigger a reorder, and how much to order?
//
// Kept as pure functions (no DB access) so both the request-time
// "suggestions" endpoint and the daily background job use identical math,
// and so it's trivially unit-testable.
// ------------------------------------------------------------

const RECENT_WINDOW_DAYS = 30;
const SAFETY_FACTOR = 1.25; // cushion against day-to-day variability, not just the average
const MIN_TREND_FACTOR = 0.5; // don't let a slow trend crater the reorder point
const MAX_TREND_FACTOR = 1.75; // don't let a spike alone triple it either

/**
 * @param {number} recentSold - units sold in the last RECENT_WINDOW_DAYS
 * @param {number} priorSold - units sold in the RECENT_WINDOW_DAYS before that
 * @returns {number} daily velocity, already adjusted for the recent trend
 */
function computeVelocity(recentSold, priorSold) {
  const recentVelocity = recentSold / RECENT_WINDOW_DAYS;
  if (priorSold <= 0) return recentVelocity; // no baseline to compare against yet
  const trendFactor = recentSold / priorSold;
  const clamped = Math.min(Math.max(trendFactor, MIN_TREND_FACTOR), MAX_TREND_FACTOR);
  return recentVelocity * clamped;
}

/**
 * @param {number} velocity - daily units, from computeVelocity
 * @param {number} leadTimeDays - days between placing and receiving an order
 * @returns {number} the on-hand quantity that should trigger a reorder
 */
function computeReorderPoint(velocity, leadTimeDays) {
  return Math.ceil(velocity * leadTimeDays * SAFETY_FACTOR);
}

/**
 * How much to order once the reorder point is hit: enough to cover the
 * point itself plus one more full lead time of cushion, topped up to the
 * supplier's minimum order quantity.
 */
function computeSuggestedQty({ velocity, leadTimeDays, reorderPoint, onHand, minOrderQty }) {
  const targetStock = reorderPoint + Math.ceil(velocity * leadTimeDays);
  const needed = Math.max(0, targetStock - onHand);
  return Math.max(needed, minOrderQty || 1);
}

/** Convenience wrapper combining the three steps for one product's raw numbers. */
function evaluateProduct({ recentSold, priorSold, leadTimeDays, onHand, minOrderQty }) {
  const velocity = computeVelocity(recentSold, priorSold);
  const reorderPoint = computeReorderPoint(velocity, leadTimeDays);
  const suggestedQty = computeSuggestedQty({ velocity, leadTimeDays, reorderPoint, onHand, minOrderQty });
  return {
    velocityPerDay: Math.round(velocity * 100) / 100,
    reorderPoint,
    needsReorder: onHand <= reorderPoint,
    suggestedQty,
  };
}

module.exports = {
  RECENT_WINDOW_DAYS,
  computeVelocity,
  computeReorderPoint,
  computeSuggestedQty,
  evaluateProduct,
};

// Only the owner (admin) and managers see what products cost and the markup;
// everyone else (cashiers, shelf staff…) sees just the selling price.
const SEES_COST = new Set(['admin', 'manager', 'super_admin']);

function seesCost(req) {
  return SEES_COST.has(req?.user?.role);
}

/** A product row (or list) without cost, markup and stock value, for staff who must not see them. */
function forViewer(req, data) {
  if (seesCost(req) || !data) return data;
  const strip = (p) => {
    if (!p || typeof p !== 'object') return p;
    const { cost_price, price_multiplier, stock_value, ...rest } = p; // eslint-disable-line no-unused-vars
    if (rest.selling_price == null && cost_price != null) rest.selling_price = Math.round(Number(cost_price) * Number(price_multiplier) * 100) / 100;
    return rest;
  };
  return Array.isArray(data) ? data.map(strip) : strip(data);
}

module.exports = { seesCost, forViewer };

// The price a shopper pays: the sale price while a promotion runs, else
// cost x markup. One definition for the till, the online shop and reports.
const onSaleSql = (a = 'p') => `(${a}.promo_price IS NOT NULL AND ${a}.promo_price > 0 AND (${a}.promo_ends_at IS NULL OR ${a}.promo_ends_at > now()))`;
const priceSql = (a = 'p') => `ROUND(CASE WHEN ${onSaleSql(a)} THEN ${a}.promo_price ELSE ${a}.cost_price * ${a}.price_multiplier END, 2)`;
const regularSql = (a = 'p') => `ROUND(${a}.cost_price * ${a}.price_multiplier, 2)`;

function onSale(p, now = Date.now()) {
  return p && Number(p.promo_price) > 0 && (!p.promo_ends_at || new Date(p.promo_ends_at).getTime() > now);
}
function effectivePrice(p) {
  return onSale(p) ? Number(p.promo_price) : Number(p.cost_price) * Number(p.price_multiplier);
}

module.exports = { onSaleSql, priceSql, regularSql, onSale, effectivePrice };

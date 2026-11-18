// ------------------------------------------------------------
// Business insights computed in plain JS from raw rows, so the cloud
// (Postgres) and desktop (SQLite) editions share one implementation —
// desktop/server/utils/insights.js is a verbatim copy; keep them identical.
//
// Inputs:
//   products: [{ id, name, sku, category, cost_price, price_multiplier, shelf_qty, backroom_qty, created_at, archived_at }]
//   lines:    [{ product_id, quantity, line_total, paid_at }]   — paid POS sales in the window
//   returns:  [{ product_id, quantity, amount }]                 — refunds in the window (optional)
// ------------------------------------------------------------

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function byProduct(lines, returns = []) {
  const m = new Map();
  for (const l of lines) {
    const v = m.get(l.product_id) || { units: 0, revenue: 0 };
    v.units += Number(l.quantity); v.revenue += Number(l.line_total);
    m.set(l.product_id, v);
  }
  for (const r of returns) {
    const v = m.get(r.product_id) || { units: 0, revenue: 0 };
    v.units -= Number(r.quantity); v.revenue -= Number(r.amount);
    m.set(r.product_id, v);
  }
  return m;
}

/** Profit & margin per product and overall. Cost uses the product's current cost price. */
function profit({ products, lines, returns = [] }) {
  const agg = byProduct(lines, returns);
  const rows = [];
  let revenue = 0; let cost = 0;
  for (const p of products) {
    const a = agg.get(p.id);
    if (!a || (a.units === 0 && a.revenue === 0)) continue;
    const c = Number(p.cost_price) * a.units;
    revenue += a.revenue; cost += c;
    rows.push({
      productId: p.id, name: p.name, sku: p.sku, category: p.category || null, units: a.units,
      revenue: r2(a.revenue), cost: r2(c), profit: r2(a.revenue - c), marginPct: a.revenue > 0 ? r2(((a.revenue - c) / a.revenue) * 100) : 0,
    });
  }
  rows.sort((x, y) => y.profit - x.profit);
  const byCategory = {};
  for (const r of rows) {
    const k = r.category || 'Uncategorised';
    byCategory[k] = byCategory[k] || { category: k, revenue: 0, profit: 0 };
    byCategory[k].revenue = r2(byCategory[k].revenue + r.revenue);
    byCategory[k].profit = r2(byCategory[k].profit + r.profit);
  }
  return {
    revenue: r2(revenue), cost: r2(cost), profit: r2(revenue - cost), marginPct: revenue > 0 ? r2(((revenue - cost) / revenue) * 100) : 0,
    products: rows, categories: Object.values(byCategory).sort((a, b) => b.revenue - a.revenue),
  };
}

/** ABC analysis: A = items making the first 80% of revenue, B = next 15%, C = the rest. */
function abc({ products, lines, returns = [] }) {
  const agg = byProduct(lines, returns);
  const rows = products.filter((p) => !p.archived_at).map((p) => ({ productId: p.id, name: p.name, sku: p.sku, revenue: r2(agg.get(p.id)?.revenue || 0), units: agg.get(p.id)?.units || 0 }));
  rows.sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((s, r) => s + Math.max(r.revenue, 0), 0);
  let running = 0;
  for (const r of rows) {
    const share = total > 0 ? Math.max(r.revenue, 0) / total : 0;
    const before = running;
    running += share;
    r.sharePct = r2(share * 100);
    r.class = total === 0 || r.revenue <= 0 ? 'C' : before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
  }
  const summary = ['A', 'B', 'C'].map((c) => ({ class: c, items: rows.filter((r) => r.class === c).length, revenue: r2(rows.filter((r) => r.class === c).reduce((s, r) => s + r.revenue, 0)) }));
  return { total: r2(total), summary, products: rows };
}

/** Products with stock on hand but no sale in `days` days (money sitting on the shelf). */
function deadStock({ products, lastSold, days, now = new Date() }) {
  const cutoff = now.getTime() - days * 86400000;
  const rows = [];
  for (const p of products) {
    if (p.archived_at) continue;
    const onHand = Number(p.shelf_qty) + Number(p.backroom_qty);
    if (onHand <= 0) continue;
    const last = lastSold.get(p.id) ? new Date(lastSold.get(p.id)).getTime() : null;
    const since = last || new Date(p.created_at).getTime();
    if (since > cutoff) continue;
    rows.push({
      productId: p.id, name: p.name, sku: p.sku, onHand, lastSoldAt: last ? new Date(last).toISOString() : null,
      daysIdle: Math.floor((now.getTime() - since) / 86400000), valueAtCost: r2(onHand * Number(p.cost_price)),
    });
  }
  rows.sort((a, b) => b.valueAtCost - a.valueAtCost);
  return { days, totalValue: r2(rows.reduce((s, r) => s + r.valueAtCost, 0)), products: rows };
}

/** Simple demand forecast: average daily units over the window → days of stock cover and a reorder hint. */
function forecast({ products, lines, days, leadTimeDefault = 7 }) {
  const agg = byProduct(lines);
  const rows = [];
  for (const p of products) {
    if (p.archived_at) continue;
    const units = agg.get(p.id)?.units || 0;
    const perDay = units / Math.max(days, 1);
    const onHand = Number(p.shelf_qty) + Number(p.backroom_qty);
    const cover = perDay > 0 ? onHand / perDay : null;
    const lead = Number(p.lead_time_days) || leadTimeDefault;
    const next30 = Math.ceil(perDay * 30);
    rows.push({
      productId: p.id, name: p.name, sku: p.sku, onHand, avgDaily: r2(perDay), next30Days: next30,
      daysOfCover: cover == null ? null : Math.floor(cover), leadTimeDays: lead,
      reorderNow: perDay > 0 && cover <= lead,
      suggestedQty: perDay > 0 ? Math.max(0, Math.ceil(perDay * (lead + 14)) - onHand) : 0,
    });
  }
  rows.sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity));
  return { days, products: rows.filter((r) => r.avgDaily > 0 || r.onHand > 0) };
}

/** 7×24 grid of sales by weekday (0 = Sunday) and hour, in the given IANA time zone. */
function heatmap({ orders, timeZone = 'UTC' }) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const o of orders) {
    const parts = fmt.formatToParts(new Date(o.paid_at));
    const d = DOW[parts.find((p) => p.type === 'weekday').value];
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    grid[d][h] = r2(grid[d][h] + Number(o.total));
  }
  return { timeZone, grid };
}

module.exports = { profit, abc, deadStock, forecast, heatmap };

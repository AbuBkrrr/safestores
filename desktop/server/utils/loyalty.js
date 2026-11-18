// ------------------------------------------------------------
// Loyalty points maths (pure JS; desktop/server/utils/loyalty.js is a copy).
// Earned points expire `expiryMonths` after they were earned (0 = never).
// Redemptions consume the OLDEST unexpired points first, so a customer
// never loses points that a redemption could have used.
// ------------------------------------------------------------

function pointsEarned(total, per100) {
  const p = Number(per100) || 0;
  if (p <= 0) return 0;
  return Math.floor((Number(total) || 0) / 100 * p);
}

/** entries: [{ points, created_at, expires_at }] (any order). Returns { available, expired, earned, redeemed, expiringSoon }. */
function balance(entries, now = new Date(), soonDays = 30) {
  const earned = entries.filter((e) => e.points > 0).map((e) => ({ ...e, left: Number(e.points) }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const redemptions = entries.filter((e) => e.points < 0).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let redeemed = 0;
  for (const r of redemptions) {
    let need = -Number(r.points);
    redeemed += need;
    const at = new Date(r.created_at);
    for (const e of earned) {
      if (need <= 0) break;
      if (e.left <= 0) continue;
      if (e.expires_at && new Date(e.expires_at) <= at) continue; // already expired when redeemed
      const take = Math.min(e.left, need);
      e.left -= take; need -= take;
    }
  }
  let available = 0; let expired = 0; let expiringSoon = 0;
  const soon = now.getTime() + soonDays * 86400000;
  for (const e of earned) {
    if (e.expires_at && new Date(e.expires_at) <= now) expired += e.left;
    else {
      available += e.left;
      if (e.expires_at && new Date(e.expires_at).getTime() <= soon) expiringSoon += e.left;
    }
  }
  return { available, expired, redeemed, earned: earned.reduce((s, e) => s + Number(e.points), 0), expiringSoon };
}

function expiryDate(from, months) {
  if (!months) return null;
  const d = new Date(from);
  d.setMonth(d.getMonth() + Number(months));
  return d;
}

module.exports = { pointsEarned, balance, expiryDate };

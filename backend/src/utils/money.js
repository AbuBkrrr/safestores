// Server-side money formatting for emails (mirrors frontend/src/utils/currency.js).
function formatMoney(amount, currency = {}) {
  const n = Number(amount) || 0;
  const symbol = currency.symbol || currency.code || '';
  if (currency.code && /^[A-Z]{3}$/.test(currency.code)) {
    try {
      const parts = new Intl.NumberFormat('en', { style: 'currency', currency: currency.code, currencyDisplay: 'narrowSymbol' }).formatToParts(n);
      return parts.map((p) => (p.type === 'currency' ? symbol : p.value)).join('');
    } catch { /* fall through */ }
  }
  return `${symbol}${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
module.exports = { formatMoney };

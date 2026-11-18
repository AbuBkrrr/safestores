// Quick-pick list shown first in currency pickers. Any ISO 4217 code the
// browser knows is accepted (see allCurrencyCodes) — this list is just the
// most common choices for the app's markets.
export const CURRENCIES = [
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira' },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian Cedi' },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand' },
  { code: 'XOF', symbol: 'CFA', name: 'West African CFA Franc' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
];

export const DEFAULT_CURRENCY = { code: 'NGN', symbol: '₦' };

export function allCurrencyCodes() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('currency');
  } catch { /* older browser */ }
  return CURRENCIES.map((c) => c.code);
}

export function currencyName(code, locale) {
  try { return new Intl.DisplayNames([locale || undefined], { type: 'currency' }).of(code) || code; } catch { return CURRENCIES.find((c) => c.code === code)?.name || code; }
}

export function currencySymbol(code) {
  return CURRENCIES.find((c) => c.code === code)?.symbol || code || DEFAULT_CURRENCY.symbol;
}

function uiLocale() {
  if (typeof document !== 'undefined' && document.documentElement.lang) return document.documentElement.lang;
  return undefined;
}

/** Formats an amount using the given currency (an object with `code` and/or
 * `symbol`, e.g. what CurrencyContext exposes) or a bare currency code.
 * Uses the browser's locale-aware number formatting (digit grouping,
 * decimals per currency — e.g. 0 decimals for XOF) with the store's own
 * symbol, so "₦1,250.00", "1 250,00 €" style differences come out right. */
export function formatCurrency(amount, currency) {
  const code = typeof currency === 'string' ? currency : currency?.code;
  const symbol = typeof currency === 'string' ? currencySymbol(currency) : (currency?.symbol || currencySymbol(code));
  const n = Number(amount) || 0;
  if (code && /^[A-Z]{3}$/.test(code)) {
    try {
      const parts = new Intl.NumberFormat(uiLocale(), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(n);
      return parts.map((p) => (p.type === 'currency' ? symbol : p.value)).join('');
    } catch { /* fall through to the simple format */ }
  }
  return `${symbol}${n.toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

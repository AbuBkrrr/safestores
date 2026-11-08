// Curated list of currencies a Super Admin can choose between — deliberately
// not "every ISO 4217 code" (over a hundred), just the ones actually
// plausible for this app's markets. Add more here if you expand elsewhere.
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

export function currencySymbol(code) {
  return CURRENCIES.find((c) => c.code === code)?.symbol || code || DEFAULT_CURRENCY.symbol;
}

/** Formats an amount using the given currency (an object with at least
 * `symbol`, e.g. what CurrencyContext exposes) or a bare currency code. */
export function formatCurrency(amount, currency) {
  const symbol = typeof currency === 'string' ? currencySymbol(currency) : (currency?.symbol || DEFAULT_CURRENCY.symbol);
  const n = Number(amount) || 0;
  return `${symbol}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

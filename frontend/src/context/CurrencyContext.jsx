import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client.js';
import { useOptionalAuth } from './AuthContext.jsx';
import { DEFAULT_CURRENCY, formatCurrency as format } from '../utils/currency.js';

const CurrencyContext = createContext(null);

// Currency is per store now (Store Settings), falling back to the
// platform default. A signed-in store user gets their store's currency;
// public pages (storefront, digital receipts) pass a storeId themselves
// via useStoreCurrency / the receipt payload.
export function CurrencyProvider({ children }) {
  const auth = useOptionalAuth();
  const storeId = auth.user?.storeId || null;
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);

  const load = useCallback(() => {
    api.get('/settings/currency', { params: storeId ? { storeId } : {} })
      .then((r) => { if (r.data) setCurrency(r.data); })
      .catch(() => {}); // keep the default if the request fails for any reason
  }, [storeId]);

  useEffect(() => { load(); }, [load]);

  const formatCurrency = useCallback((amount) => format(amount, currency), [currency]);

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, formatCurrency, refreshCurrency: load }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider');
  return ctx;
}

/** For public pages that know which store they're showing. */
export function useStoreCurrency(storeId) {
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  useEffect(() => {
    if (!storeId) return;
    api.get('/settings/currency', { params: { storeId } }).then((r) => r.data && setCurrency(r.data)).catch(() => {});
  }, [storeId]);
  return { currency, formatCurrency: (amount) => format(amount, currency) };
}

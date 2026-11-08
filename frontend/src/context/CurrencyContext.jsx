import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client.js';
import { DEFAULT_CURRENCY, formatCurrency as format } from '../utils/currency.js';

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);

  const load = useCallback(() => {
    api.get('/settings/currency')
      .then((r) => { if (r.data) setCurrency(r.data); })
      .catch(() => {}); // keep the default if the request fails for any reason
  }, []);

  // Public endpoint (see app.js) — loads once on mount regardless of
  // login state, so unauthenticated pages (e.g. the public Storefront)
  // still reflect the real configured currency, not just admin pages.
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

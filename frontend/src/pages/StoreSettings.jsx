import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { CURRENCIES, allCurrencyCodes, currencyName, formatCurrency } from '../utils/currency.js';

function allTimezones() {
  try { if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ }
  return ['UTC', 'Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'America/New_York'];
}

/** Admin-only: currency, time zone, tax, receipt text and till rules for THIS store. */
export default function StoreSettings() {
  const { t, i18n } = useTranslation();
  const { user, updateUser } = useAuth();
  const { refreshCurrency } = useCurrency();
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const timezones = useMemo(allTimezones, []);
  const codes = useMemo(() => {
    const quick = CURRENCIES.map((c) => c.code);
    return [...quick, ...allCurrencyCodes().filter((c) => !quick.includes(c))];
  }, []);

  useEffect(() => { api.get(`/stores/${user.storeId}/settings`).then((r) => setS(r.data)); }, [user.storeId]);
  if (!s) return <p className="muted">{t('common.loading')}</p>;

  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.patch(`/stores/${user.storeId}/settings`, {
        name: s.name, currencyCode: s.store_currency_code || null, timezone: s.timezone,
        taxRatePct: Number(s.tax_rate_pct) || 0, taxInclusive: !!s.tax_inclusive, taxLabel: s.tax_label, taxNumber: s.tax_number || '',
        phone: s.phone || '', address: s.address || '', city: s.city || '',
        receiptHeader: s.receipt_header || '', receiptFooter: s.receipt_footer || '',
        maxCashierDiscountPct: Number(s.max_cashier_discount_pct) || 0, requireShift: !!s.require_shift,
      });
      setS(data);
      refreshCurrency();
      if (data.name !== user.storeName) updateUser({ storeName: data.name });
      showToast(t('settingsPage.saved'), 'success');
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
  };

  const preview = formatCurrency(1234.5, { code: s.store_currency_code || s.currency_code, symbol: s.store_currency_code ? undefined : s.currency_symbol });

  return (
    <div>
      <div className="topbar"><div><h1>{t('settingsPage.title')}</h1><p className="muted">{t('settingsPage.subtitle')}</p></div></div>
      <Alert type="error">{error}</Alert>
      <form onSubmit={save} className="grid grid-2">
        <div className="card">
          <h3>🏪 {t('settingsPage.store')}</h3>
          <div className="form-group"><label htmlFor="st-name">{t('settingsPage.storeName')}</label><input id="st-name" value={s.name || ''} onChange={set('name')} required /></div>
          <div className="form-group"><label htmlFor="st-phone">{t('settingsPage.phone')}</label><input id="st-phone" value={s.phone || ''} onChange={set('phone')} inputMode="tel" /></div>
          <div className="form-group"><label htmlFor="st-addr">{t('settingsPage.address')}</label><input id="st-addr" value={s.address || ''} onChange={set('address')} /></div>
          <div className="form-group"><label htmlFor="st-city">{t('settingsPage.city')}</label><input id="st-city" value={s.city || ''} onChange={set('city')} /></div>
        </div>

        <div className="card">
          <h3>🌍 {t('settingsPage.region')}</h3>
          <div className="form-group">
            <label htmlFor="st-cur">{t('settingsPage.currency')}</label>
            <select id="st-cur" value={s.store_currency_code || ''} onChange={(e) => setS({ ...s, store_currency_code: e.target.value || null })}>
              <option value="">{t('settingsPage.platformDefault', { code: s.currency_code })}</option>
              {codes.map((c) => <option key={c} value={c}>{c} — {currencyName(c, i18n.resolvedLanguage)}</option>)}
            </select>
            <span className="help-text">{t('settingsPage.preview')}: {preview}. {t('settingsPage.currencyNote')}</span>
          </div>
          <div className="form-group">
            <label htmlFor="st-tz">{t('settingsPage.timezone')}</label>
            <select id="st-tz" value={s.timezone} onChange={set('timezone')}>
              {timezones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
            <span className="help-text">{t('settingsPage.timezoneNote')}</span>
          </div>
        </div>

        <div className="card">
          <h3>🧾 {t('settingsPage.tax')}</h3>
          <div className="flex">
            <div className="form-group" style={{ flex: 1 }}><label htmlFor="st-taxlabel">{t('settingsPage.taxLabel')}</label><input id="st-taxlabel" value={s.tax_label || ''} onChange={set('tax_label')} placeholder="VAT / GST / Sales tax" /></div>
            <div className="form-group" style={{ flex: 1 }}><label htmlFor="st-taxrate">{t('settingsPage.taxRate')}</label><input id="st-taxrate" type="number" min="0" max="100" step="0.001" value={s.tax_rate_pct} onChange={set('tax_rate_pct')} /></div>
          </div>
          <label className="flex"><input type="checkbox" checked={!!s.tax_inclusive} onChange={set('tax_inclusive')} /> {t('settingsPage.taxInclusive')}</label>
          <p className="help-text">{s.tax_inclusive ? t('settingsPage.inclusiveHelp') : t('settingsPage.exclusiveHelp')}</p>
          <div className="form-group mt-1"><label htmlFor="st-taxno">{t('settingsPage.taxNumber')}</label><input id="st-taxno" value={s.tax_number || ''} onChange={set('tax_number')} /></div>
          <p className="help-text">{t('settingsPage.taxNote')}</p>
        </div>

        <div className="card">
          <h3>🛒 {t('settingsPage.till')}</h3>
          <div className="form-group"><label htmlFor="st-disc">{t('settingsPage.maxDiscount')}</label><input id="st-disc" type="number" min="0" max="100" step="0.5" value={s.max_cashier_discount_pct} onChange={set('max_cashier_discount_pct')} /><span className="help-text">{t('settingsPage.maxDiscountHelp')}</span></div>
          <label className="flex"><input type="checkbox" checked={!!s.require_shift} onChange={set('require_shift')} /> {t('settingsPage.requireShift')}</label>
          <div className="form-group mt-1"><label htmlFor="st-rh">{t('settingsPage.receiptHeader')}</label><textarea id="st-rh" value={s.receipt_header || ''} onChange={set('receipt_header')} maxLength={500} /></div>
          <div className="form-group"><label htmlFor="st-rf">{t('settingsPage.receiptFooter')}</label><textarea id="st-rf" value={s.receipt_footer || ''} onChange={set('receipt_footer')} maxLength={500} placeholder={t('settingsPage.receiptFooterPlaceholder')} /></div>
        </div>
        <div><button className="btn">{t('common.save')}</button></div>
      </form>
      <Toast {...(toast || {})} />
    </div>
  );
}

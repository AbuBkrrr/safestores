import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert } from './ui.jsx';

/**
 * Store Settings → Online payments. The store links its own bank account;
 * shopper payments are split by Paystack and settled straight to it — the
 * platform never holds the money. Only the last 4 digits are kept.
 */
export default function OnlinePaymentsCard({ onToast }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const base = `/stores/${user.storeId}/payouts`;
  const [p, setP] = useState(null);
  const [banks, setBanks] = useState([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ bankCode: '', accountNumber: '' });
  const [resolvedName, setResolvedName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === 'admin';

  const load = () => api.get(base).then((r) => setP(r.data)).catch(() => setP(null));
  useEffect(() => { load(); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = async () => {
    setError(''); setEditing(true); setResolvedName('');
    if (!banks.length) {
      try { setBanks((await api.get(`${base}/banks`)).data); } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
    }
  };

  const check = async () => {
    setError(''); setResolvedName(''); setBusy(true);
    try { setResolvedName((await api.post(`${base}/resolve`, form)).data.accountName); } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); } finally { setBusy(false); }
  };

  const link = async () => {
    setError(''); setBusy(true);
    try {
      const bankName = banks.find((b) => b.code === form.bankCode)?.name;
      setP((await api.put(base, { ...form, bankName })).data);
      setEditing(false); setForm({ bankCode: '', accountNumber: '' }); setResolvedName('');
      onToast?.(t('paymentsCard.linked'), 'success');
    } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); } finally { setBusy(false); }
  };

  const toggle = async (key, value) => {
    setError('');
    try { setP((await api.patch(base, { [key]: value })).data); } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
  };

  if (!p) return null;
  const unavailable = !p.gatewayConfigured ? t('paymentsCard.notConfigured') : !p.currencySupported ? t('paymentsCard.currencyUnsupported', { currency: p.currency }) : '';

  return (
    <div className="card">
      <h3>💳 {t('paymentsCard.title')}</h3>
      <p className="help-text">{t('paymentsCard.intro')}</p>
      {p.commissionPct > 0 && <p className="help-text">{t('paymentsCard.commission', { pct: p.commissionPct })}</p>}
      <Alert type="error">{error}</Alert>
      {unavailable && <Alert type="info">{unavailable}</Alert>}

      {p.connected && !editing && (
        <div className="mt-1">
          <p>✅ {t('paymentsCard.linkedTo', { name: p.payout_account_name, bank: p.payout_bank_name || '', last4: p.payout_account_last4 })}</p>
          {isAdmin && <button type="button" className="btn small secondary" onClick={startEdit}>{t('paymentsCard.change')}</button>}
        </div>
      )}

      {!unavailable && isAdmin && (!p.connected || editing) && (
        editing ? (
          <div className="mt-1">
            <div className="form-group">
              <label htmlFor="po-bank">{t('paymentsCard.bank')}</label>
              <select id="po-bank" value={form.bankCode} onChange={(e) => { setForm({ ...form, bankCode: e.target.value }); setResolvedName(''); }}>
                <option value="">—</option>
                {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="po-acct">{t('paymentsCard.accountNumber')}</label>
              <input id="po-acct" inputMode="numeric" autoComplete="off" value={form.accountNumber} onChange={(e) => { setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, '') }); setResolvedName(''); }} />
            </div>
            {resolvedName && <Alert type="success">{t('paymentsCard.accountName', { name: resolvedName })}</Alert>}
            <div className="flex">
              {!resolvedName
                ? <button type="button" className="btn small" disabled={busy || !form.bankCode || form.accountNumber.length < 6} onClick={check}>{t('paymentsCard.check')}</button>
                : <button type="button" className="btn small" disabled={busy} onClick={link}>{t('paymentsCard.confirmLink')}</button>}
              <button type="button" className="btn small secondary" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
            </div>
            <p className="help-text">{t('paymentsCard.privacy')}</p>
          </div>
        ) : <button type="button" className="btn small mt-1" onClick={startEdit}>{t('paymentsCard.linkAccount')}</button>
      )}

      {isAdmin && (
        <div className="mt-1">
          <label className="flex"><input type="checkbox" checked={!!p.online_payments_enabled} disabled={!p.connected} onChange={(e) => toggle('onlinePaymentsEnabled', e.target.checked)} /> {t('paymentsCard.acceptOnline')}</label>
          <label className="flex"><input type="checkbox" checked={p.pay_on_delivery_enabled !== false} onChange={(e) => toggle('payOnDeliveryEnabled', e.target.checked)} /> {t('paymentsCard.acceptOnDelivery')}</label>
        </div>
      )}
    </div>
  );
}

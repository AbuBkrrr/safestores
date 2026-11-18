import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, EmptyState, Metric } from '../components/ui.jsx';

const TYPE_ICONS = { cash_commission: '💵', online_commission: '💳', debt_recovered: '↘️', settlement_payment: '✅', adjustment: '✏️' };

/** The store's running balance with the platform for app orders (Bolt-style). */
export default function Settlements() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency: f } = useCurrency();
  const [params, setParams] = useSearchParams();
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [busy, setBusy] = useState(false);
  const base = `/stores/${user.storeId}/settlements`;

  const load = () => api.get(base).then((r) => setS(r.data));
  useEffect(() => {
    const ref = params.get('reference') || params.get('trxref');
    if (ref) {
      api.post(`${base}/verify`, { reference: ref })
        .then((r) => setMsg(r.data.paid ? { type: 'success', text: t('settlementsPage.paidThanks') } : { type: 'info', text: t('settlementsPage.notConfirmed') }))
        .catch(() => setMsg({ type: 'info', text: t('settlementsPage.notConfirmed') }))
        .finally(() => { setParams({}, { replace: true }); load(); });
    } else load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pay = async () => {
    setBusy(true); setMsg({ type: '', text: '' });
    try { window.location.assign((await api.post(`${base}/pay`, {})).data.authorizationUrl); } catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('common.errorGeneric') }); setBusy(false); }
  };

  if (!s) return <p className="muted">{t('common.loading')}</p>;
  return (
    <div>
      <div className="topbar"><div><h1>{t('settlementsPage.title')}</h1><p className="muted">{t('settlementsPage.subtitle')}</p></div></div>
      {msg.text && <Alert type={msg.type}>{msg.text}</Alert>}
      {s.cashBlocked && <Alert type="warning">{t('settlementsPage.cashPaused', { limit: f(s.terms.cashDebtLimit) })}</Alert>}

      <div className="grid grid-4">
        <Metric value={s.owes > 0 ? f(s.owes) : f(0)} label={s.owes > 0 ? t('settlementsPage.youOwe') : t('settlementsPage.balanceClear')} />
        {s.credit > 0 && <Metric value={f(s.credit)} label={t('settlementsPage.credit')} />}
        <Metric value={f(s.thisMonth.appSales)} label={t('settlementsPage.appSalesMonth')} />
        <Metric value={f(s.thisMonth.commissions)} label={t('settlementsPage.commissionMonth', { pct: s.terms.commissionPct })} />
      </div>

      {s.owes > 0 && (
        <div className="card flex-between">
          <span>{t('settlementsPage.payPrompt', { amount: f(s.owes) })}</span>
          {s.canPayOnline && user.role === 'admin'
            ? <button className="btn" disabled={busy} onClick={pay}>{t('settlementsPage.payNow', { amount: f(s.owes) })}</button>
            : <span className="muted">{t('settlementsPage.payByTransfer')}</span>}
        </div>
      )}

      <div className="card">
        <h3>{t('settlementsPage.howTitle')}</h3>
        <ul className="muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>{t('settlementsPage.howOnline', { pct: s.terms.commissionPct })}</li>
          <li>{t('settlementsPage.howCash', { pct: s.terms.commissionPct })}</li>
          <li>{t('settlementsPage.howNetting', { pct: s.terms.maxRecoveryPct })}</li>
          {s.terms.cashDebtLimit > 0 && <li>{t('settlementsPage.howLimit', { limit: f(s.terms.cashDebtLimit) })}</li>}
          <li>{t('settlementsPage.howPos')}</li>
        </ul>
      </div>

      <div className="card">
        <h3>{t('settlementsPage.statement')}</h3>
        {s.entries.length === 0 ? <EmptyState>{t('settlementsPage.empty')}</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{t('salesPage.when')}</th><th>{t('settlementsPage.entry')}</th><th style={{ textAlign: 'right' }}>{t('settlementsPage.orderTotal')}</th><th style={{ textAlign: 'right' }}>{t('settlementsPage.commission')}</th><th style={{ textAlign: 'right' }}>{t('settlementsPage.balanceChange')}</th></tr></thead>
            <tbody>{s.entries.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.created_at).toLocaleString()}</td>
                <td>{TYPE_ICONS[e.type]} {t(`settlementsPage.types.${e.type}`)}{e.note ? <div className="muted" style={{ fontSize: 12 }}>{e.note}{e.reference ? ` · ${e.reference}` : ''}</div> : null}</td>
                <td style={{ textAlign: 'right' }}>{e.order_total == null ? '—' : f(e.order_total)}</td>
                <td style={{ textAlign: 'right' }}>{e.commission == null ? '—' : f(e.commission)}</td>
                <td style={{ textAlign: 'right', color: e.amount > 0 ? 'var(--danger)' : e.amount < 0 ? 'var(--secondary)' : undefined }}>{e.amount === 0 ? '—' : `${e.amount > 0 ? '+' : '−'}${f(Math.abs(e.amount))}`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

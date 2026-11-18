import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge } from '../components/ui.jsx';
import { formatCurrency as format } from '../utils/currency.js';

// Portal for partners: guarantors settle customer credit, couriers run deliveries.
export default function PartnerPortal() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [data, setData] = useState(null);
  const [refs, setRefs] = useState({});
  const [msg, setMsg] = useState({ type: '', text: '' });
  const isCourier = user?.role === 'courier';
  const money = (n) => format(n);

  const load = () => api.get(isCourier ? '/partner/courier' : '/partner/guarantor').then((r) => setData(r.data)).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, ok) => {
    setMsg({});
    try { await fn(); setMsg({ type: 'success', text: t(ok) }); load(); } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || t('partnerPage.failed') }); }
  };

  return (
    <div className="app-shell">
      <div style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h1>{isCourier ? '🛵' : '🤝'} {user?.name}</h1>
          <button className="btn secondary small" onClick={logout}>{t('partnerPage.logOut')}</button>
        </div>
        <Alert type={msg.type}>{msg.text}</Alert>
        {!data ? <p className="muted">…</p> : isCourier ? (
          <div className="card">
            <h3>{t('partnerPage.jobs')}</h3>
            {data.length === 0 ? <p className="muted">{t('partnerPage.noJobs')}</p> : data.map((j) => (
              <div key={j.id} className="card mt-1" style={{ opacity: j.status === 'fulfilled' ? 0.6 : 1 }}>
                <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <strong>#{j.id.slice(0, 8).toUpperCase()} · {j.store_name}</strong><Badge status={j.status} />
                </div>
                <p>🏪 {t('partnerPage.pickupFrom')}: {j.store_address || '—'}{j.store_phone && <> · <a href={`tel:${j.store_phone}`}>{j.store_phone}</a></>}</p>
                <p>📍 {t('partnerPage.deliverTo')}: <strong>{j.customer_name}</strong>{j.customer_phone && <> · <a href={`tel:${j.customer_phone}`}>{j.customer_phone}</a></>} — {j.delivery_address || '—'}</p>
                {j.customer_note && <p className="muted">{j.customer_note}</p>}
                <p>{['on_delivery', 'on_pickup'].includes(j.payment_method) && j.payment_status !== 'paid'
                  ? <strong>💵 {t('partnerPage.collect', { amount: money(j.total) })}</strong>
                  : <span className="muted">✅ {t('partnerPage.noCash')}</span>}</p>
                <div className="flex" style={{ gap: 8 }}>
                  {j.status === 'confirmed' && <button className="btn small" onClick={() => act(() => api.patch(`/partner/courier/jobs/${j.id}/picked-up`), 'partnerPage.pickedUpOk')}>{t('partnerPage.pickedUp')}</button>}
                  {j.status === 'out_for_delivery' && <button className="btn small" onClick={() => act(() => api.patch(`/partner/courier/jobs/${j.id}/delivered`), 'partnerPage.deliveredOk')}>{t('partnerPage.delivered')}</button>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="card">
              <h3>{t('partnerPage.members')}</h3>
              {data.accounts.length === 0 ? <p className="muted">{t('partnerPage.noMembers')}</p> : (
                <div style={{ overflowX: 'auto' }}><table>
                  <thead><tr><th>{t('partnerPage.member')}</th><th>{t('partnerPage.store')}</th><th>{t('partnerPage.ref')}</th><th>{t('partnerPage.limit')}</th><th>{t('partnerPage.used')}</th><th>{t('partnerPage.status')}</th><th>{t('partnerPage.isMember')}</th></tr></thead>
                  <tbody>{data.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.customer_name}<div className="muted" style={{ fontSize: 11 }}>{a.customer_phone}</div></td>
                      <td>{a.store_name}</td><td>{a.member_ref}</td>
                      <td>{money(a.status === 'pending' ? a.requested_limit : a.credit_limit)}</td><td>{money(a.used)}</td>
                      <td><Badge status={a.status} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {a.member_verified === true ? '✅' : a.member_verified === false ? '❌' : ''}{' '}
                        <button className="btn small" onClick={() => act(() => api.patch(`/partner/guarantor/accounts/${a.id}/verify`, { verified: true }), 'partnerPage.saved')}>{t('partnerPage.yes')}</button>{' '}
                        <button className="btn small secondary" onClick={() => act(() => api.patch(`/partner/guarantor/accounts/${a.id}/verify`, { verified: false }), 'partnerPage.saved')}>{t('partnerPage.no')}</button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
            <div className="card mt-1">
              <h3>{t('partnerPage.toSettle')} — {money(data.owed.reduce((s, o) => s + Number(o.total), 0))}</h3>
              {data.owed.length === 0 ? <p className="muted">{t('partnerPage.nothingOwed')}</p> : (
                <div style={{ overflowX: 'auto' }}><table>
                  <thead><tr><th>{t('partnerPage.store')}</th><th>{t('partnerPage.member')}</th><th>{t('partnerPage.ref')}</th><th>{t('partnerPage.delivered')}</th><th>{t('partnerPage.amount')}</th><th>{t('partnerPage.payment')}</th></tr></thead>
                  <tbody>{data.owed.map((o) => (
                    <tr key={o.id}>
                      <td>{o.store_name}</td><td>{o.customer_name}</td><td>{o.member_ref}</td>
                      <td>{new Date(o.fulfilled_at).toLocaleDateString()}</td><td>{money(o.total)}</td>
                      <td>{o.guarantor_paid_reported_at
                        ? <span className="muted">⏳ {t('partnerPage.reported', { ref: o.guarantor_paid_ref })}</span>
                        : <span className="flex" style={{ gap: 4 }}>
                          <input style={{ width: 130 }} placeholder={t('partnerPage.payRef')} aria-label={t('partnerPage.payRef')} value={refs[o.id] || ''} onChange={(e) => setRefs({ ...refs, [o.id]: e.target.value })} />
                          <button className="btn small" disabled={!refs[o.id]} onClick={() => act(() => api.post(`/partner/guarantor/orders/${o.id}/report-payment`, { reference: refs[o.id] }), 'partnerPage.reportedOk')}>{t('partnerPage.paid')}</button>
                        </span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

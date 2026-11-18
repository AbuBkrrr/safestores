import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Badge } from './ui.jsx';
import { InviteLink } from './CouriersPanel.jsx';

const KINDS = ['bank', 'cooperative', 'pfa', 'employer', 'other'];

// Guaranteed customer credit, store side: guarantors, applications, and
// the statement each guarantor settles. See backend creditController.
export default function CreditPanel({ onToast }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const base = `/stores/${user.storeId}/credit`;
  const [guarantors, setGuarantors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [statement, setStatement] = useState([]);
  const [gForm, setGForm] = useState({ name: '', kind: 'cooperative', contactName: '', phone: '', email: '' });
  const [limits, setLimits] = useState({});
  const [error, setError] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const canManage = ['admin', 'manager'].includes(user.role);

  const load = () => Promise.all([
    api.get(`${base}/guarantors`).then((r) => setGuarantors(r.data)),
    api.get(`${base}/accounts`).then((r) => setAccounts(r.data)),
    api.get(`${base}/statement`).then((r) => setStatement(r.data)),
  ]).catch(() => {});
  useEffect(() => { load(); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeEvents(['credit:applied', 'marketplace:order_fulfilled'], () => load());

  const act = async (fn, okKey) => {
    setError('');
    try { await fn(); if (okKey) onToast?.(t(okKey), 'success'); load(); } catch (err) { setError(err.response?.data?.error || t('creditPanel.failed')); }
  };
  const addGuarantor = (e) => { e.preventDefault(); act(async () => { await api.post(`${base}/guarantors`, gForm); setGForm({ ...gForm, name: '', contactName: '', phone: '', email: '' }); }, 'creditPanel.saved'); };
  const review = (a, status) => act(() => api.patch(`${base}/accounts/${a.id}`, { status, creditLimit: status === 'approved' ? Number(limits[a.id] ?? a.requested_limit) : undefined }), 'creditPanel.saved');
  const invitePortal = (g) => {
    const email = window.prompt(t('partnerInvite.guarantorEmail', { name: g.name }), g.email || '');
    if (email) act(async () => { const { data } = await api.post(`/stores/${user.storeId}/partner-invites`, { kind: 'guarantor', email, guarantorId: g.id }); setInviteLink(data.link); });
  };
  const settle = (o) => act(() => api.patch(`/stores/${user.storeId}/marketplace/orders/${o.id}/credit-settled`), 'creditPanel.settled');

  const byGuarantor = statement.reduce((m, o) => { (m[o.guarantor_name] ||= []).push(o); return m; }, {});

  return (
    <div className="card">
      <h3>🤝 {t('creditPanel.title')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('creditPanel.intro')}</p>
      <Alert type="error">{error}</Alert>

      <h4 className="mt-1">{t('creditPanel.guarantors')}</h4>
      <table>
        <thead><tr><th>{t('creditPanel.name')}</th><th>{t('creditPanel.kind')}</th><th>{t('creditPanel.contact')}</th><th>{t('creditPanel.outstanding')}</th><th></th></tr></thead>
        <tbody>{guarantors.map((g) => (
          <tr key={g.id}><td>{g.name}</td><td>{t(`storefrontPage.gKind_${g.kind}`)}</td><td>{[g.contact_name, g.phone, g.email].filter(Boolean).join(' · ') || '—'}</td>
            <td>{formatCurrency(g.outstanding)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{g.partner_id ? <span className="muted" style={{ fontSize: 12 }}>✅ {t('partnerInvite.onPortal')} </span>
              : canManage && <button className="btn small" onClick={() => invitePortal(g)}>{t('partnerInvite.invitePortal')}</button>}{' '}
              {canManage && <button className="btn small secondary" onClick={() => act(() => api.patch(`${base}/guarantors/${g.id}`, { active: !g.active }))}>{g.active ? t('creditPanel.pause') : t('creditPanel.resume')}</button>}</td></tr>
        ))}</tbody>
      </table>
      <InviteLink link={inviteLink} />
      {canManage && <form onSubmit={addGuarantor} className="grid grid-2 mt-1">
        <div className="form-group"><label htmlFor="g-name">{t('creditPanel.name')}</label><input id="g-name" value={gForm.name} onChange={(e) => setGForm({ ...gForm, name: e.target.value })} placeholder="Unity Cooperative Society" required /></div>
        <div className="form-group"><label htmlFor="g-kind">{t('creditPanel.kind')}</label>
          <select id="g-kind" value={gForm.kind} onChange={(e) => setGForm({ ...gForm, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`storefrontPage.gKind_${k}`)}</option>)}</select></div>
        <div className="form-group"><label htmlFor="g-cn">{t('creditPanel.contactName')}</label><input id="g-cn" value={gForm.contactName} onChange={(e) => setGForm({ ...gForm, contactName: e.target.value })} /></div>
        <div className="form-group"><label htmlFor="g-ph">{t('creditPanel.phoneEmail')}</label><input id="g-ph" value={gForm.phone} onChange={(e) => setGForm({ ...gForm, phone: e.target.value })} /></div>
        <div><button className="btn small" type="submit">{t('creditPanel.addGuarantor')}</button></div>
      </form>}

      <h4 className="mt-1">{t('creditPanel.accounts')}</h4>
      {accounts.length === 0 ? <p className="muted">{t('creditPanel.noAccounts')}</p> : (
        <table>
          <thead><tr><th>{t('creditPanel.customer')}</th><th>{t('creditPanel.guarantor')}</th><th>{t('creditPanel.memberRef')}</th><th>{t('creditPanel.limit')}</th><th>{t('creditPanel.used')}</th><th>{t('creditPanel.status')}</th><th></th></tr></thead>
          <tbody>{accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.customer_name}<div className="muted" style={{ fontSize: 11 }}>{a.customer_phone || a.customer_email}</div></td>
              <td>{a.guarantor_name}</td><td>{a.member_ref}{a.member_verified === true ? ' ✅' : a.member_verified === false ? ' ❌' : ''}</td>
              <td>{a.status === 'pending'
                ? <input type="number" min="1" style={{ width: 110 }} aria-label={t('creditPanel.limit')} value={limits[a.id] ?? a.requested_limit} onChange={(e) => setLimits({ ...limits, [a.id]: e.target.value })} />
                : formatCurrency(a.credit_limit)}</td>
              <td>{formatCurrency(a.used)}</td>
              <td><Badge status={a.status} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>{canManage && <>
                {a.status !== 'approved' && <button className="btn small" onClick={() => review(a, 'approved')}>{t('creditPanel.approve')}</button>}{' '}
                {a.status === 'pending' && <button className="btn small secondary" onClick={() => review(a, 'rejected')}>{t('creditPanel.reject')}</button>}
                {a.status === 'approved' && <button className="btn small secondary" onClick={() => review(a, 'suspended')}>{t('creditPanel.suspend')}</button>}
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h4 className="mt-1">{t('creditPanel.statement')}</h4>
      {statement.length === 0 ? <p className="muted">{t('creditPanel.nothingOwed')}</p> : Object.entries(byGuarantor).map(([name, rows]) => (
        <div key={name} className="mt-1">
          <strong>{name}</strong> — {t('creditPanel.owes')} {formatCurrency(rows.reduce((s, o) => s + Number(o.total), 0))}
          <table className="mt-1">
            <thead><tr><th>{t('creditPanel.customer')}</th><th>{t('creditPanel.memberRef')}</th><th>{t('creditPanel.delivered')}</th><th>{t('creditPanel.amount')}</th><th></th></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id}><td>{o.customer_name}</td><td>{o.member_ref}</td><td>{new Date(o.fulfilled_at).toLocaleDateString()}</td><td>{formatCurrency(o.total)}{o.guarantor_paid_reported_at && <div className="muted" style={{ fontSize: 11 }}>💸 {t('partnerInvite.reportedPaid', { ref: o.guarantor_paid_ref })}</div>}</td>
                <td>{canManage && <button className="btn small" onClick={() => settle(o)}>{t('creditPanel.markSettled')}</button>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {statement.length > 0 && <button className="btn small secondary mt-1" onClick={() => window.print()}>🖨️ {t('creditPanel.print')}</button>}
    </div>
  );
}

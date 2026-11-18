import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// Shows a freshly created partner invite link to copy / share.
export function InviteLink({ link }) {
  const { t } = useTranslation();
  if (!link) return null;
  const share = () => (navigator.share ? navigator.share({ url: link }).catch(() => {}) : navigator.clipboard?.writeText(link));
  return (
    <div className="alert success mt-1" style={{ wordBreak: 'break-all' }}>
      {t('partnerInvite.sendLink')}<br /><code>{link}</code><br />
      <button type="button" className="btn small mt-1" onClick={share}>📋 {t('partnerInvite.copyShare')}</button>
    </div>
  );
}

// Store side: delivery companies / riders who log in to the partner portal.
export default function CouriersPanel({ couriers, reload, onToast }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const canManage = ['admin', 'manager'].includes(user.role);

  const invite = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.post(`/stores/${user.storeId}/partner-invites`, { kind: 'courier', email });
      setLink(data.link); setEmail('');
    } catch (err) { onToast?.(err.response?.data?.error || t('creditPanel.failed'), 'error'); }
  };
  const toggle = async (c) => { await api.patch(`/stores/${user.storeId}/couriers/${c.id}`, { active: !c.active }).catch(() => {}); reload(); };

  return (
    <div className="card">
      <h3>🛵 {t('partnerInvite.couriersTitle')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('partnerInvite.couriersIntro')}</p>
      {couriers.length > 0 && (
        <table>
          <thead><tr><th>{t('creditPanel.name')}</th><th>{t('creditPanel.contact')}</th><th>{t('partnerInvite.openJobs')}</th><th></th></tr></thead>
          <tbody>{couriers.map((c) => (
            <tr key={c.id}><td>{c.name}</td><td>{[c.phone, c.email].filter(Boolean).join(' · ')}</td><td>{c.open_jobs}</td>
              <td>{canManage && <button className="btn small secondary" onClick={() => toggle(c)}>{c.active ? t('creditPanel.pause') : t('creditPanel.resume')}</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {canManage && (
        <form onSubmit={invite} className="flex mt-1" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input type="email" required placeholder={t('partnerInvite.courierEmail')} aria-label={t('partnerInvite.courierEmail')} value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn small" type="submit">{t('partnerInvite.inviteCourier')}</button>
        </form>
      )}
      <InviteLink link={link} />
    </div>
  );
}

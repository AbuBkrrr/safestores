import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import InviteShareModal from '../components/InviteShareModal.jsx';
import { useStoreTier, MINI_ROLES } from '../utils/useStoreTier.js';

const APP_BASE_URL = window.location.origin;

function inviteLink(code) {
  return `${APP_BASE_URL}/login?invite=${code}`;
}

// Every role a store user can hold (the store auditor is time-boxed to an audit engagement).
// Desktop has no auditor marketplace, so an outside auditor joins by invite there.
const INVITE_ROLES = ['staff', 'cashier', 'checkout', 'store_manager', 'shelf_manager', 'marketplace_manager', 'security', 'manager', 'admin',
  ...(import.meta.env.VITE_EDITION === 'desktop' ? ['auditor'] : [])];

export default function Invites() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [invites, setInvites] = useState([]);
  const [single, setSingle] = useState({ name: '', email: '', role: 'staff' });
  const [bulk, setBulk] = useState({ names: '', emailDomain: '', role: 'staff' });
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const storeTier = useStoreTier();
  const roleOptions = storeTier === 'mini' ? INVITE_ROLES.filter((r) => MINI_ROLES.includes(r)) : INVITE_ROLES;
  const [sharing, setSharing] = useState(null); // invite whose share card is open
  const load = () => api.get(`/stores/${user.storeId}/invites`).then((r) => setInvites(r.data));
  useEffect(() => { load(); }, [user.storeId]);

  const createSingle = async (e) => {
    e.preventDefault(); setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/invites`, single);
      setSingle({ name: '', email: '', role: 'staff' });
      showToast(t('invitesPage.inviteCreated'), 'success');
      if (data?.code) setSharing(data); // straight to QR / WhatsApp / email / download
      load();
    } catch (err) { setError(err.response?.data?.error || t('invitesPage.createInviteFailed')); }
  };

  const createBulk = async (e) => {
    e.preventDefault(); setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/invites/bulk`, bulk);
      setBulk({ names: '', emailDomain: '', role: 'staff' });
      showToast(t('invitesPage.bulkCreated', { count: data.length }), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('invitesPage.bulkCreationFailed')); }
  };

  const revoke = async (id) => {
    await api.patch(`/stores/${user.storeId}/invites/${id}/revoke`);
    load();
  };

  const copyAll = () => {
    const text = invites.filter((i) => i.status === 'pending').map((i) => `${i.name}: ${i.code}`).join('\n');
    navigator.clipboard.writeText(text);
    showToast(t('invitesPage.allPendingCopied'), 'success');
  };

  const share = (invite, channel) => {
    const link = inviteLink(invite.code);
    const message = `You've been invited to join ${user.storeName || 'our store'} on SAFE Stores!\nYour invite code: ${invite.code}\nOr click: ${link}`;
    const encoded = encodeURIComponent(message);
    const urls = {
      whatsapp: `https://wa.me/?text=${encoded}`,
      sms: `sms:?&body=${encoded}`,
      email: `mailto:${invite.email || ''}?subject=${encodeURIComponent('Your SAFE Stores Invite')}&body=${encoded}`,
    };
    if (channel === 'copy') {
      navigator.clipboard.writeText(message);
      showToast(t('invitesPage.inviteMessageCopied'), 'success');
      return;
    }
    if (channel === 'native' && navigator.share) {
      navigator.share({ title: 'SAFE Stores Invite', text: message }).catch(() => {});
      return;
    }
    window.open(urls[channel], '_blank');
  };

  return (
    <div>
      <div className="topbar"><h1>{t('invitesPage.title')}</h1></div>
      {storeTier === 'mini' && <div className="alert info">🏪 {t('invitesPage.miniNote')}</div>}
      <Alert type="error">{error}</Alert>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('invitesPage.single')}</h3>
          <form onSubmit={createSingle}>
            <div className="form-group"><label>{t('invitesPage.name')}</label><input value={single.name} onChange={(e) => setSingle({ ...single, name: e.target.value })} required /></div>
            <div className="form-group"><label>{t('invitesPage.emailOptional')}</label><input type="email" value={single.email} onChange={(e) => setSingle({ ...single, email: e.target.value })} /></div>
            <div className="form-group">
              <label>{t('invitesPage.role')}</label>
              <select value={single.role} onChange={(e) => setSingle({ ...single, role: e.target.value })}>
                {roleOptions.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
              </select>
            </div>
            <button className="btn">{t('invitesPage.createInvite')}</button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('invitesPage.bulk')}</h3>
          <form onSubmit={createBulk}>
            <div className="form-group">
              <label>{t('invitesPage.names')}</label>
              <textarea rows={3} placeholder="Alice Johnson, Bob Smith, Carol White"
                value={bulk.names} onChange={(e) => setBulk({ ...bulk, names: e.target.value })} required />
            </div>
            <div className="form-group"><label>{t('invitesPage.emailDomain')}</label>
              <input value={bulk.emailDomain} onChange={(e) => setBulk({ ...bulk, emailDomain: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('invitesPage.roleAppliedToAll')}</label>
              <select value={bulk.role} onChange={(e) => setBulk({ ...bulk, role: e.target.value })}>
                {roleOptions.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
              </select>
            </div>
            <button className="btn">{t('invitesPage.createBulkInvites')}</button>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="flex-between">
          <h3>{t('invitesPage.allInvites')}</h3>
          <button className="btn secondary small" onClick={copyAll}>{t('invitesPage.copyAllPending')}</button>
        </div>
        <table className="mt-1">
          <thead><tr><th>{t('invitesPage.name')}</th><th>{t('invitesPage.emailAction')}</th><th>{t('invitesPage.role')}</th><th>{t('invitesPage.code')}</th><th>{t('invitesPage.status')}</th><th>{t('invitesPage.share')}</th></tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td><td>{i.email || '—'}</td><td><span className="role-tag">{t(`roles.${i.role}`, { defaultValue: i.role })}</span></td>
                <td><span className="code-chip">{i.code}</span></td>
                <td><Badge status={i.status} /></td>
                <td>
                  {i.status === 'pending' && (
                    <div className="flex">
                      <button className="btn small" onClick={() => setSharing(i)}>📱 {t('inviteShare.qrShare')}</button>
                      <button className="btn small secondary" onClick={() => share(i, 'whatsapp')}>{t('invitesPage.whatsapp', { defaultValue: 'WhatsApp' })}</button>
                      <button className="btn small secondary" onClick={() => share(i, 'email')}>{t('invitesPage.emailAction')}</button>
                      <button className="btn small secondary" onClick={() => share(i, 'sms')}>{t('invitesPage.smsAction')}</button>
                      <button className="btn small secondary" onClick={() => share(i, 'copy')}>{t('invitesPage.copyAction')}</button>
                      <button className="btn danger small" onClick={() => revoke(i.id)}>{t('invitesPage.revokeAction')}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sharing && (
        <InviteShareModal invite={sharing} link={inviteLink(sharing.code)} storeName={user.storeName || 'Our store'}
          onClose={() => setSharing(null)} onShare={(ch) => share(sharing, ch)} />
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

export default function AuditorDashboard() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [engagements, setEngagements] = useState([]);
  const [inviteForms, setInviteForms] = useState({}); // engagementId -> {name, email}
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get('/auditor/engagements').then((r) => setEngagements(r.data));
  useEffect(() => { load(); }, []);

  const open = engagements.filter((e) => e.status === 'requested');
  const mine = engagements.filter((e) => e.status === 'accepted' || e.status === 'in_progress');
  const past = engagements.filter((e) => e.status === 'completed' || e.status === 'cancelled');

  const accept = async (id) => {
    try {
      await api.patch(`/auditor/engagements/${id}/accept`);
      showToast(t('auditorDashPage.engagementAccepted'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('auditorDashPage.acceptFailed')); }
  };

  const complete = async (id) => {
    await api.patch(`/auditor/engagements/${id}/complete`);
    showToast(t('auditorDashPage.engagementCompleted'), 'success');
    load();
  };

  const invite = async (id) => {
    const form = inviteForms[id];
    if (!form?.name || !form?.email) return;
    await api.post(`/auditor/engagements/${id}/invites`, form);
    showToast(t('auditorDashPage.inviteSentTo', { name: form.name }), 'success');
    setInviteForms((f) => ({ ...f, [id]: { name: '', email: '' } }));
  };

  return (
    <div className="app-shell">
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>{t('auditorDashPage.title', { name: user?.name })}</h1>
          <button className="btn secondary small" onClick={logout}>{t('auditorDashPage.logOut')}</button>
        </div>
        <Alert type="error">{error}</Alert>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('auditorDashPage.openRequests')}</h3>
          {open.length === 0 && <p className="muted">{t('auditorDashPage.noOpenRequests')}</p>}
          {open.map((e) => (
            <div key={e.id} className="card" style={{ background: 'var(--bg)' }}>
              <strong>{e.store_name}</strong> <Badge status={e.status} />
              <p className="muted">{e.notes || t('auditorDashPage.noNotesProvided')} · {t('auditorDashPage.requestedAt', { time: new Date(e.requested_at).toLocaleString() })}</p>
              <button className="btn small mt-1" onClick={() => accept(e.id)}>{t('auditorDashPage.acceptEngagement')}</button>
            </div>
          ))}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('auditorDashPage.myActiveEngagements')}</h3>
          {mine.length === 0 && <p className="muted">{t('auditorDashPage.noActiveEngagements')}</p>}
          {mine.map((e) => (
            <div key={e.id} className="card" style={{ background: 'var(--bg)' }}>
              <strong>{e.store_name}</strong> <Badge status={e.status} />
              <p className="muted">{e.notes}</p>
              <div className="flex mt-1">
                <input placeholder={t('auditorDashPage.stockTakerName')} value={inviteForms[e.id]?.name || ''}
                  onChange={(ev) => setInviteForms((f) => ({ ...f, [e.id]: { ...f[e.id], name: ev.target.value } }))} />
                <input placeholder={t('auditorDashPage.email')} value={inviteForms[e.id]?.email || ''}
                  onChange={(ev) => setInviteForms((f) => ({ ...f, [e.id]: { ...f[e.id], email: ev.target.value } }))} />
                <button className="btn small" onClick={() => invite(e.id)}>{t('auditorDashPage.inviteStockTaker')}</button>
              </div>
              <button className="btn secondary small mt-1" onClick={() => complete(e.id)}>{t('auditorDashPage.markComplete')}</button>
            </div>
          ))}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('auditorDashPage.pastEngagements')}</h3>
          {past.length === 0 && <p className="muted">{t('auditorDashPage.noneYet')}</p>}
          {past.map((e) => (
            <div key={e.id} className="flex" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
              <span>{e.store_name}</span><Badge status={e.status} />
            </div>
          ))}
        </div>
        <Toast {...(toast || {})} />
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

export default function Auditor() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [engagements, setEngagements] = useState([]);
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState('');
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/audit-engagements`).then((r) => setEngagements(r.data));
  useEffect(() => { load(); }, [user.storeId]);

  const activeEngagement = engagements.find((e) => e.status === 'accepted' || e.status === 'in_progress');

  const request = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/stores/${user.storeId}/audit-engagements`, { notes, scheduledFor: when ? new Date(when).toISOString() : null });
      showToast(t('auditorPage.auditRequested'), 'success');
      setNotes(''); setWhen('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('auditorPage.requestFailed'));
    }
  };

  return (
    <div>
      <div className="topbar"><h1>{t('auditorPage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="card">
        <p className="muted">
          {t('auditorPage.serviceDesc')}
        </p>
        {activeEngagement ? (
          <div className="card mt-1" style={{ background: '#eef7ee', borderColor: '#8fc98f' }}>
            {t('auditorPage.activeEngagement', { name: activeEngagement.auditor_name, email: activeEngagement.auditor_email })}{' '}
            <Link to="/shelf-audit">{t('auditorPage.goToShelfAudit')}</Link>
          </div>
        ) : (
          <form onSubmit={request} className="mt-1">
            <div className="form-group">
              <label htmlFor="audit-when">{t('auditorPage.when')}</label>
              <input id="audit-when" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)}
                min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} />
              <p className="muted" style={{ fontSize: 12 }}>{t('auditorPage.whenHelp')}</p>
            </div>
            <div className="form-group">
              <label>{t('auditorPage.notesForAuditor')}</label>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('auditorPage.notesPlaceholder')} />
            </div>
            <button className="btn">{t('auditorPage.bookAudit')}</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('auditorPage.requestHistory')}</h3>
        <table>
          <thead><tr><th>{t('auditorPage.requested')}</th><th>{t('auditorPage.when')}</th><th>{t('auditorPage.auditor')}</th><th>{t('usersPage.status')}</th><th>{t('auditorPage.notes')}</th></tr></thead>
          <tbody>
            {engagements.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.requested_at).toLocaleString()}</td>
                <td>{e.scheduled_for ? new Date(e.scheduled_for).toLocaleString() : '—'}</td>
                <td>{e.auditor_name || (e.status === 'requested' ? t('auditorPage.awaitingAssignment') : '—')}{e.auditor_name && e.status === 'requested' && <div className="muted" style={{ fontSize: 11 }}>{t('auditorPage.awaitingAuditor')}</div>}</td>
                <td><Badge status={e.status} /></td>
                <td>{e.notes || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {engagements.length === 0 && <p className="muted">{t('auditorPage.noAuditRequests')}</p>}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

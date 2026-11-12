import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

export default function Support() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ subject: '', message: '', priority: 'normal' });
  const [replyText, setReplyText] = useState('');
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/support/tickets`).then((r) => setTickets(r.data));
  useEffect(() => { load(); }, [user.storeId]);

  const openTicket = async (id) => {
    const { data } = await api.get(`/stores/${user.storeId}/support/tickets/${id}`);
    setSelected(data);
  };

  const createTicket = async (e) => {
    e.preventDefault(); setError('');
    if (!form.subject || !form.message) return;
    try {
      await api.post(`/stores/${user.storeId}/support/tickets`, form);
      setForm({ subject: '', message: '', priority: 'normal' });
      showToast(t('supportPage.ticketSubmitted'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('supportPage.ticketSubmitFailed')); }
  };

  const sendReply = async () => {
    if (!replyText.trim()) return;
    await api.post(`/stores/${user.storeId}/support/tickets/${selected.id}/reply`, { message: replyText });
    setReplyText('');
    openTicket(selected.id);
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>{t('supportPage.title')}</h1></div>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('supportPage.newTicket')}</h3>
          <Alert type="error">{error}</Alert>
          <form onSubmit={createTicket}>
            <div className="form-group">
              <label>{t('supportPage.subject')}</label>
              <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>{t('supportPage.priority')}</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="low">{t('supportPage.priorityLow')}</option>
                <option value="normal">{t('supportPage.priorityNormal')}</option>
                <option value="high">{t('supportPage.priorityHigh')}</option>
                <option value="urgent">{t('supportPage.priorityUrgent')}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('supportPage.message')}</label>
              <textarea rows={5} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required />
            </div>
            <button className="btn">{t('supportPage.submitTicket')}</button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('supportPage.yourTickets')}</h3>
          {tickets.length === 0 && <EmptyState>{t('supportPage.noTicketsYet')}</EmptyState>}
          {tickets.length > 0 && (
            <table className="mt-1">
              <thead><tr><th>{t('supportPage.subject')}</th><th>{t('supportPage.priority')}</th><th>{t('supportPage.status')}</th><th>{t('supportPage.updated')}</th></tr></thead>
              <tbody>
                {tickets.map((t2) => (
                  <tr key={t2.id} style={{ cursor: 'pointer' }} onClick={() => openTicket(t2.id)}>
                    <td>{t2.subject}</td>
                    <td>{t(`supportPage.priority${t2.priority.charAt(0).toUpperCase()}${t2.priority.slice(1)}`, { defaultValue: t2.priority })}</td>
                    <td><Badge status={t2.status} /></td>
                    <td className="muted">{new Date(t2.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && (
        <div className="card mt-2">
          <div className="flex-between">
            <h3>{selected.subject}</h3>
            <Badge status={selected.status} />
          </div>
          <p className="mt-1">{selected.message}</p>
          <div className="mt-1" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            {selected.replies.map((r) => (
              <div key={r.id} className="mt-1">
                <strong>{r.author_type === 'super_admin' ? `${r.author_name} ${t('supportPage.supportSuffix')}` : r.author_name}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(r.created_at).toLocaleString()}</span>
                <p>{r.message}</p>
              </div>
            ))}
          </div>
          {selected.status !== 'closed' && (
            <div className="mt-1">
              <textarea rows={3} placeholder={t('supportPage.writeReply')} value={replyText} onChange={(e) => setReplyText(e.target.value)} />
              <button className="btn mt-1" onClick={sendReply}>{t('supportPage.sendReply')}</button>
            </div>
          )}
        </div>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

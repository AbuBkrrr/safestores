import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

export default function Integrations() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [webhooks, setWebhooks] = useState([]);
  const [availableEvents, setAvailableEvents] = useState([]);
  const [form, setForm] = useState({ url: '', events: [] });
  const [newSecret, setNewSecret] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const EVENT_LABELS = {
    'receipt.applied': t('integrationsPage.eventReceiptApplied'),
    'order.paid': t('integrationsPage.eventOrderPaid'),
    'purchase_order.auto_created': t('integrationsPage.eventPoAutoCreated'),
    'support_ticket.created': t('integrationsPage.eventTicketCreated'),
    'support_ticket.replied': t('integrationsPage.eventTicketReplied'),
  };

  const load = () => api.get(`/stores/${user.storeId}/webhooks`).then((r) => {
    setWebhooks(r.data.webhooks);
    setAvailableEvents(r.data.availableEvents);
  });
  useEffect(() => { load(); }, [user.storeId]);

  const toggleEvent = (ev) => {
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev],
    }));
  };

  const create = async (e) => {
    e.preventDefault(); setError(''); setNewSecret(null);
    if (!form.url || form.events.length === 0) { setError(t('integrationsPage.webhookRequired')); return; }
    try {
      const { data } = await api.post(`/stores/${user.storeId}/webhooks`, form);
      setNewSecret(data.secret);
      setForm({ url: '', events: [] });
      showToast(t('integrationsPage.webhookCreated'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('integrationsPage.webhookCreateFailed')); }
  };

  const toggleActive = async (hook) => {
    await api.patch(`/stores/${user.storeId}/webhooks/${hook.id}`, { active: !hook.active });
    load();
  };

  const remove = async (id) => {
    await api.delete(`/stores/${user.storeId}/webhooks/${id}`);
    load();
  };

  const test = async (id) => {
    const { data } = await api.post(`/stores/${user.storeId}/webhooks/${id}/test`);
    showToast(data.delivered ? t('integrationsPage.testDelivered', { code: data.statusCode }) : t('integrationsPage.testFailed', { error: data.error }), data.delivered ? 'success' : 'error');
    load();
  };

  if (user.role !== 'admin') {
    return (
      <div>
        <div className="topbar"><h1>{t('integrationsPage.title')}</h1></div>
        <Alert type="error">{t('integrationsPage.adminOnly')}</Alert>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar"><h1>{t('integrationsPage.title')}</h1></div>
      <p className="muted mt-1" style={{ marginBottom: 16 }}>
        {t('integrationsPage.webhookIntro')}
      </p>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('integrationsPage.newWebhook')}</h3>
          <Alert type="error">{error}</Alert>
          {newSecret && (
            <Alert type="warning">
              {t('integrationsPage.signingSecret')} <code>{newSecret}</code>
            </Alert>
          )}
          <form onSubmit={create}>
            <div className="form-group">
              <label>{t('integrationsPage.endpointUrl')}</label>
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://your-service.example.com/webhook" required />
            </div>
            <div className="form-group">
              <label>{t('integrationsPage.events')}</label>
              {availableEvents.map((ev) => (
                <label key={ev} style={{ display: 'block', fontWeight: 400, marginBottom: 4 }}>
                  <input type="checkbox" checked={form.events.includes(ev)} onChange={() => toggleEvent(ev)} style={{ marginRight: 8, width: 'auto' }} />
                  {EVENT_LABELS[ev] || ev}
                </label>
              ))}
            </div>
            <button className="btn">{t('integrationsPage.createWebhook')}</button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('integrationsPage.yourWebhooks')}</h3>
          {webhooks.length === 0 && <EmptyState>{t('integrationsPage.noWebhooksYet')}</EmptyState>}
          {webhooks.map((h) => (
            <div key={h.id} className="mt-1" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
              <div className="flex-between">
                <strong style={{ wordBreak: 'break-all' }}>{h.url}</strong>
                <Badge status={h.active ? 'active' : 'suspended'} />
              </div>
              <div className="muted mt-1">{h.events.map((e) => EVENT_LABELS[e] || e).join(', ')}</div>
              <div className="muted">
                {h.last_triggered_at
                  ? t('integrationsPage.lastDelivery', { time: new Date(h.last_triggered_at).toLocaleString(), code: h.last_status_code ?? t('integrationsPage.failed') })
                  : t('integrationsPage.neverTriggered')}
              </div>
              <div className="flex mt-1">
                <button className="btn small secondary" onClick={() => test(h.id)}>{t('integrationsPage.sendTest')}</button>
                <button className="btn small secondary" onClick={() => toggleActive(h)}>{h.active ? t('integrationsPage.pause') : t('integrationsPage.resume')}</button>
                <button className="btn small danger" onClick={() => remove(h.id)}>{t('integrationsPage.delete')}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

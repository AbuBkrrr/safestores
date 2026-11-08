import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Alert, Badge, EmptyState, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

const TYPE_LABEL = { bank: 'Bank', microfinance: 'Microfinance', lending_app: 'Lending App', other: 'Other' };

// Manages the lending_partners registry — the store-facing consent page
// (frontend/src/pages/LendingPartners.jsx) only ever shows partners
// created here with status 'active'; a partner sits invisible to every
// store until toggled active below.
export default function LendingPartnersAdmin() {
  const [partners, setPartners] = useState([]);
  const [form, setForm] = useState({ name: '', type: 'bank', contactName: '', contactEmail: '', contactPhone: '' });
  const [newKey, setNewKey] = useState(null); // { name, apiKey } — shown once, right after create/regenerate
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, showToast] = useToast();

  const load = () => api.get('/super/lending-partners').then((r) => setPartners(r.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setError(''); setNewKey(null);
    if (!form.name) { setError('Partner name is required'); return; }
    try {
      const { data } = await api.post('/super/lending-partners', form);
      setNewKey({ name: data.name, apiKey: data.apiKey });
      setForm({ name: '', type: 'bank', contactName: '', contactEmail: '', contactPhone: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create partner');
    }
  };

  const setStatus = async (partner, status) => {
    try {
      await api.patch(`/super/lending-partners/${partner.id}`, { status });
      showToast(`${partner.name} is now ${status}`, status === 'active' ? 'success' : 'info');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to update status', 'error');
    }
  };

  const regenerateKey = async (partner) => {
    if (!confirm(`Generate a new API key for ${partner.name}? Their current key will stop working immediately.`)) return;
    const { data } = await api.post(`/super/lending-partners/${partner.id}/regenerate-key`);
    setNewKey({ name: data.name, apiKey: data.apiKey });
  };

  if (loading) return <div className="topbar"><h1>🏦 Lending Partners</h1></div>;

  return (
    <div>
      <div className="topbar"><h1>🏦 Lending Partners</h1></div>
      <p className="muted mt-1" style={{ marginBottom: 20 }}>
        Banks and microfinance/lending apps that can request an aggregate financial summary (months active, monthly
        revenue trend, order counts — never line-item transactions or customer data) for stores that explicitly
        consent to share with them. A partner only appears on a store admin's Lending Partners screen once its
        status here is Active.
      </p>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Register a Partner</h3>
          <Alert type="error">{error}</Alert>
          {newKey && (
            <Alert type="warning">
              API key for <strong>{newKey.name}</strong> (shown once — copy it now): <code>{newKey.apiKey}</code>
            </Alert>
          )}
          <form onSubmit={create}>
            <div className="form-group">
              <label>Partner Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="bank">Bank</option>
                <option value="microfinance">Microfinance</option>
                <option value="lending_app">Lending App</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Contact Name</label>
              <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Contact Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Contact Phone</label>
              <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </div>
            <button className="btn">Register Partner</button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>All Partners</h3>
          {partners.length === 0 && <EmptyState>No lending partners registered yet.</EmptyState>}
          {partners.map((p) => (
            <div key={p.id} className="mt-1" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
              <div className="flex-between">
                <strong>{p.name}</strong>
                <Badge status={p.status} />
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {TYPE_LABEL[p.type] || p.type} · {p.consenting_store_count} store{p.consenting_store_count === 1 ? '' : 's'} sharing
              </div>
              {p.contact_email && <div className="muted" style={{ fontSize: 13 }}>{p.contact_name ? `${p.contact_name} — ` : ''}{p.contact_email}</div>}
              <div className="flex mt-1">
                {p.status !== 'active' && <button className="btn small" onClick={() => setStatus(p, 'active')}>Activate</button>}
                {p.status === 'active' && <button className="btn small secondary" onClick={() => setStatus(p, 'suspended')}>Suspend</button>}
                {p.status === 'pending' && <button className="btn small secondary" onClick={() => setStatus(p, 'suspended')}>Reject</button>}
                <button className="btn small secondary" onClick={() => regenerateKey(p)}>Regenerate Key</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

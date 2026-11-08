import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, Toast, Modal } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

const TIERS = [
  { id: 'mini', label: 'Mini Store' },
  { id: 'midi', label: 'Midi Store' },
  { id: 'mega', label: 'Mega Store' },
];
const STATUSES = ['pending', 'active', 'suspended'];
const BILLING_MODELS = [
  { id: 'daily_percentage', label: 'Daily % of revenue' },
  { id: 'custom', label: 'Custom arrangement' },
];

const emptyCreateForm = {
  storeName: '', adminName: '', adminEmail: '', password: '',
  storeTier: 'mini', billingModel: 'daily_percentage', dailyRatePercent: 1, referralContact: '',
  linkToCloud: false, linkedStoreId: '', linkedSyncKey: '', cloudUrl: '',
};
const EDITION = import.meta.env.VITE_EDITION || 'web';
// The backend's own base URL — what a desktop install actually needs to
// pair with this store, which is NOT necessarily this dashboard's own
// origin (frontend and backend are often on different domains/hosts).
// Falls back to this page's own origin for local dev, where Vite proxies
// /api to the backend on the same-ish origin.
const cloudApiOrigin = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/api\/?$/, '');

export default function ManageStores() {
  const [stores, setStores] = useState([]);
  const [toast, showToast] = useToast();
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [editing, setEditing] = useState(null); // store row being edited, or null
  const [editForm, setEditForm] = useState(null);
  const [viewingConnection, setViewingConnection] = useState(null); // store row to show Store ID/Sync Key for

  const load = () => api.get('/super/stores').then((r) => setStores(r.data));
  useEffect(() => { load(); }, []);

  const suspend = async (id) => { await api.patch(`/super/stores/${id}/suspend`); showToast('Store suspended', 'success'); load(); };
  const remove = async (id) => {
    if (!confirm('Permanently delete this store and all its data?')) return;
    await api.delete(`/super/stores/${id}`); showToast('Store deleted', 'success'); load();
  };

  const openCreate = () => { setCreateForm(emptyCreateForm); setCreating(true); };
  const submitCreate = async (e) => {
    e.preventDefault();
    try {
      const { linkToCloud, linkedStoreId, linkedSyncKey, cloudUrl, ...rest } = createForm;
      const body = linkToCloud ? { ...rest, linkedStoreId, linkedSyncKey, cloudUrl } : rest;
      await api.post('/super/stores', body);
      showToast('Store created', 'success');
      setCreating(false);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to create store', 'error');
    }
  };

  const openEdit = (s) => {
    setEditing(s);
    setEditForm({
      name: s.name,
      storeTier: s.store_tier,
      subscriptionStatus: s.subscription_status,
      billingModel: s.billing_model,
      dailyRatePercent: s.daily_rate_percent,
      gracePeriodMinutes: s.grace_period_minutes,
      customBillingNotes: s.custom_billing_notes || '',
      locked: !!s.locked,
      marketplaceEnabled: s.marketplace_enabled !== false,
    });
  };
  const submitEdit = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/super/stores/${editing.id}`, editForm);
      showToast('Store updated', 'success');
      setEditing(null);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to update store', 'error');
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>🏪 Manage Stores</h1>
        <button className="btn" onClick={openCreate}>+ Create Store</button>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Store</th><th>Tier</th><th>Status</th><th>Users</th><th>Products</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td><td>{s.tier_label || s.store_tier}
                  {s.requested_tier && s.requested_tier !== s.store_tier && (
                    <div className="muted" style={{ fontSize: 12 }} title="What the owner picked at signup — not yet matched by the assigned tier">
                      requested: {s.requested_tier}
                    </div>
                  )}</td>
                <td>
                  <Badge status={s.subscription_status} />
                  {s.locked && <span className="badge overdue" style={{ marginLeft: 6 }} title="Locked for non-payment">🔒 Locked</span>}
                </td>
                <td>{s.user_count}</td><td>{s.product_count}</td>
                <td>{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="flex">
                  <button className="btn secondary small" onClick={() => setViewingConnection(s)}>🔗 Connect</button>
                  <button className="btn secondary small" onClick={() => openEdit(s)}>Edit</button>
                  {s.subscription_status === 'active' && <button className="btn secondary small" onClick={() => suspend(s.id)}>Suspend</button>}
                  <button className="btn danger small" onClick={() => remove(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                No stores yet — create one, or wait for a store admin to register via Sign Up.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <Modal title="Create Store" onClose={() => setCreating(false)}>
          <form onSubmit={submitCreate}>
            <div className="form-group">
              <label>Store Name</label>
              <input value={createForm.storeName} onChange={(e) => setCreateForm({ ...createForm, storeName: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Admin Name</label>
              <input value={createForm.adminName} onChange={(e) => setCreateForm({ ...createForm, adminName: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Admin Email</label>
              <input type="email" value={createForm.adminEmail} onChange={(e) => setCreateForm({ ...createForm, adminEmail: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Admin Password</label>
              <input type="password" minLength={6} value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Store Size</label>
              <select value={createForm.storeTier} onChange={(e) => setCreateForm({ ...createForm, storeTier: e.target.value })}>
                {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Billing Model</label>
              <select value={createForm.billingModel} onChange={(e) => setCreateForm({ ...createForm, billingModel: e.target.value })}>
                {BILLING_MODELS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            {createForm.billingModel === 'daily_percentage' && (
              <div className="form-group">
                <label>Daily Rate (%)</label>
                <input type="number" step="0.1" min="0" value={createForm.dailyRatePercent}
                  onChange={(e) => setCreateForm({ ...createForm, dailyRatePercent: e.target.value })} />
              </div>
            )}
            <div className="form-group">
              <label>Referred By <span className="muted">(optional — marketer's email or phone)</span></label>
              <input value={createForm.referralContact}
                onChange={(e) => setCreateForm({ ...createForm, referralContact: e.target.value })} />
            </div>
            {EDITION === 'desktop' && (
              <div className="form-group" style={{ background: '#f8fafb', padding: 12, borderRadius: 8 }}>
                <label className="flex" style={{ alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={createForm.linkToCloud}
                    onChange={(e) => setCreateForm({ ...createForm, linkToCloud: e.target.checked })} />
                  Link this device to a store already registered with a Super Admin in the cloud
                </label>
                {createForm.linkToCloud && (
                  <>
                    <p className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
                      Get these from whoever manages your subscription — Super Admin &gt; Manage Stores &gt;
                      🔗 Connect on your store's row.
                    </p>
                    <div className="form-group">
                      <label>Store ID</label>
                      <input value={createForm.linkedStoreId} onChange={(e) => setCreateForm({ ...createForm, linkedStoreId: e.target.value })} required />
                    </div>
                    <div className="form-group">
                      <label>Sync Key</label>
                      <input value={createForm.linkedSyncKey} onChange={(e) => setCreateForm({ ...createForm, linkedSyncKey: e.target.value })} required />
                    </div>
                    <div className="form-group">
                      <label>Cloud URL</label>
                      <input value={createForm.cloudUrl} onChange={(e) => setCreateForm({ ...createForm, cloudUrl: e.target.value })}
                        placeholder="https://your-safe-stores-api.example.com" required />
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn">Create Store</button>
            </div>
          </form>
        </Modal>
      )}

      {editing && editForm && (
        <Modal title={`Edit — ${editing.name}`} onClose={() => setEditing(null)}>
          <form onSubmit={submitEdit}>
            <div className="form-group">
              <label>Store Name</label>
              <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Store Size</label>
              <select value={editForm.storeTier} onChange={(e) => setEditForm({ ...editForm, storeTier: e.target.value })}>
                {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Subscription Status</label>
              <select value={editForm.subscriptionStatus} onChange={(e) => setEditForm({ ...editForm, subscriptionStatus: e.target.value })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Billing Model</label>
              <select value={editForm.billingModel} onChange={(e) => setEditForm({ ...editForm, billingModel: e.target.value })}>
                {BILLING_MODELS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            {editForm.billingModel === 'daily_percentage' ? (
              <div className="form-group">
                <label>Daily Rate (%)</label>
                <input type="number" step="0.1" min="0" value={editForm.dailyRatePercent}
                  onChange={(e) => setEditForm({ ...editForm, dailyRatePercent: e.target.value })} />
              </div>
            ) : (
              <div className="form-group">
                <label>Custom Billing Notes</label>
                <textarea rows={3} value={editForm.customBillingNotes}
                  onChange={(e) => setEditForm({ ...editForm, customBillingNotes: e.target.value })} />
              </div>
            )}
            <div className="form-group">
              <label>Grace Period (minutes)</label>
              <input type="number" min="0" value={editForm.gracePeriodMinutes}
                onChange={(e) => setEditForm({ ...editForm, gracePeriodMinutes: e.target.value })} />
            </div>
            <div className="form-group flex">
              <input type="checkbox" id="locked" checked={editForm.locked}
                onChange={(e) => setEditForm({ ...editForm, locked: e.target.checked })} />
              <label htmlFor="locked" style={{ margin: 0 }}>Locked (blocks store access until unlocked)</label>
            </div>
            <div className="form-group flex" style={{ alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="marketplaceEnabled" checked={editForm.marketplaceEnabled}
                onChange={(e) => setEditForm({ ...editForm, marketplaceEnabled: e.target.checked })} />
              <label htmlFor="marketplaceEnabled" style={{ margin: 0 }}>Visible in online marketplace</label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn">Save Changes</button>
            </div>
          </form>
        </Modal>
      )}

      {viewingConnection && (
        <Modal title={`Connect a desktop install — ${viewingConnection.name}`} onClose={() => setViewingConnection(null)}>
          <p className="muted" style={{ marginBottom: 12 }}>
            Give these to the store owner. When they create their store in the desktop app's
            setup, choosing "Link to an existing cloud store" and entering these three values
            connects it to this exact store record — that's what makes backup sync, billing,
            and marketplace order fulfillment all line up correctly.
          </p>
          <div className="form-group">
            <label>Store ID</label>
            <div className="flex" style={{ gap: 8 }}>
              <input readOnly value={viewingConnection.id} style={{ flex: 1, fontFamily: 'monospace' }} />
              <button type="button" className="btn small secondary" onClick={() => navigator.clipboard.writeText(viewingConnection.id)}>Copy</button>
            </div>
          </div>
          <div className="form-group">
            <label>Sync Key</label>
            <div className="flex" style={{ gap: 8 }}>
              <input readOnly value={viewingConnection.sync_key} style={{ flex: 1, fontFamily: 'monospace' }} />
              <button type="button" className="btn small secondary" onClick={() => navigator.clipboard.writeText(viewingConnection.sync_key)}>Copy</button>
            </div>
          </div>
          <div className="form-group">
            <label>Cloud URL</label>
            <div className="flex" style={{ gap: 8 }}>
              <input readOnly value={cloudApiOrigin} style={{ flex: 1, fontFamily: 'monospace' }} />
              <button type="button" className="btn small secondary" onClick={() => navigator.clipboard.writeText(cloudApiOrigin)}>Copy</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              This is the backend API's own URL, not this dashboard's — double-check it if your
              API is hosted on a different domain than this Super Admin page.
            </p>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Treat the Sync Key like a password — anyone with it can push data into this store's backup.
          </p>
          <div className="modal-actions">
            <button className="btn secondary" onClick={() => setViewingConnection(null)}>Close</button>
          </div>
        </Modal>
      )}

      <Toast {...(toast || {})} />
    </div>
  );
}

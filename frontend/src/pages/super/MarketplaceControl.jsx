import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Toast, EmptyState } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

// Dedicated marketplace on/off control — separate from ManageStores.jsx's
// full edit form, this is the fast-toggle view for the one thing Super
// Admin needs to do most often here: bring a store online/offline in the
// customer-facing marketplace. Store admins can't touch this switch
// themselves (see backend's updateMarketplaceProfile) — only Super Admin.
export default function MarketplaceControl() {
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, showToast] = useToast();

  const load = () => api.get('/super/stores').then((r) => setStores(r.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const toggle = async (store) => {
    const next = !store.marketplace_enabled;
    // Optimistic update so the toggle feels instant, matching the mockup's toggle-switch UX.
    setStores((prev) => prev.map((s) => (s.id === store.id ? { ...s, marketplace_enabled: next } : s)));
    try {
      await api.patch(`/super/stores/${store.id}`, { marketplaceEnabled: next });
      showToast(`${store.name} is now ${next ? 'online' : 'offline'} in the marketplace`, next ? 'success' : 'info');
    } catch (err) {
      setStores((prev) => prev.map((s) => (s.id === store.id ? { ...s, marketplace_enabled: !next } : s)));
      showToast(err.response?.data?.error || 'Failed to update', 'error');
    }
  };

  const onlineCount = stores.filter((s) => s.marketplace_enabled).length;
  const offlineCount = stores.length - onlineCount;
  const totalProducts = stores.reduce((sum, s) => sum + Number(s.product_count || 0), 0);

  if (loading) return <div className="topbar"><h1>🛒 Marketplace Control</h1></div>;

  return (
    <div>
      <div className="topbar">
        <h1>🛒 Marketplace Control</h1>
        <div className="flex">
          <span className="badge active">{onlineCount} Online</span>
          <span className="badge suspended">{offlineCount} Offline</span>
        </div>
      </div>
      <p className="muted mt-1" style={{ marginBottom: 20 }}>
        Toggling a store here is the only way it appears (or doesn't) in the customer-facing marketplace —
        stores can set their own category/address, but can't flip this switch themselves.
      </p>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card metric">
          <div className="value">{stores.length}</div>
          <div className="label">Total Stores</div>
        </div>
        <div className="card metric">
          <div className="value">{onlineCount}</div>
          <div className="label">Online</div>
        </div>
        <div className="card metric">
          <div className="value">{totalProducts.toLocaleString()}</div>
          <div className="label">Products Listed</div>
        </div>
        <div className="card metric">
          <div className="value">{stores.filter((s) => s.subscription_status === 'active').length}</div>
          <div className="label">Active Subscriptions</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Store Marketplace Status</h3>
        {stores.length === 0 && <EmptyState>No stores registered yet.</EmptyState>}
        <table>
          <thead>
            <tr><th>Store</th><th>Category</th><th>City</th><th>Products</th><th>Subscription</th><th>Marketplace</th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td>{s.category || <span className="muted">—</span>}</td>
                <td>{s.city || <span className="muted">—</span>}</td>
                <td>{s.product_count}</td>
                <td><span className={`badge ${s.subscription_status}`}>{s.subscription_status}</span></td>
                <td>
                  <label className="flex" style={{ cursor: 'pointer', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={!!s.marketplace_enabled}
                      disabled={s.subscription_status !== 'active'}
                      onChange={() => toggle(s)}
                    />
                    <span className={`badge ${s.marketplace_enabled ? 'active' : 'suspended'}`}>
                      {s.marketplace_enabled ? '🟢 Online' : '🔴 Offline'}
                    </span>
                  </label>
                  {s.subscription_status !== 'active' && (
                    <div className="muted" style={{ fontSize: 11 }}>Subscription must be active first</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

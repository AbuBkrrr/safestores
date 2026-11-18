import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Metric } from '../../components/ui.jsx';
import { useCurrency } from '../../context/CurrencyContext.jsx';

export default function SuperDashboard() {
  const { formatCurrency } = useCurrency();
  const [stores, setStores] = useState([]);
  const [revenueThisMonth, setRevenueThisMonth] = useState(0);
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    api.get('/super/stores').then((r) => setStores(r.data));
    loadNotifications();

    // "Monthly Recurring Revenue" used to read s.price_cents, a field that
    // no longer exists after the tier-model migration (fixed-price plans
    // were replaced by daily-percentage billing) — it would silently show
    // "$NaN". Real money collected this calendar month is the sum of paid
    // billing_charges instead.
    api.get('/super/billing-charges', { params: { status: 'paid' } }).then((r) => {
      const now = new Date();
      const total = r.data
        .filter((c) => {
          const d = new Date(c.charge_date);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        })
        .reduce((sum, c) => sum + Number(c.amount_due), 0);
      setRevenueThisMonth(total);
    });
  }, []);

  const loadNotifications = () => api.get('/super/notifications', { params: { unreadOnly: 'true' } }).then((r) => setNotifications(r.data));

  const dismiss = async (id) => {
    await api.patch(`/super/notifications/${id}/dismiss`);
    loadNotifications();
  };

  const dismissAll = async () => {
    await api.patch('/super/notifications/dismiss-all');
    loadNotifications();
  };

  const active = stores.filter((s) => s.subscription_status === 'active').length;
  const pending = stores.filter((s) => s.subscription_status === 'pending').length;
  const suspended = stores.filter((s) => s.subscription_status === 'suspended').length;

  const ICONS = { payment_claim: '💵', overdue_warning: '⚠️', store_locked: '🔒' };

  return (
    <div>
      <div className="topbar"><h1>⭐ Super Admin Dashboard</h1></div>
      <div className="grid grid-4">
        <Metric value={stores.length} label="Total Stores" />
        <Metric value={active} label="Active" />
        <Metric value={pending} label="Pending Activation" />
        <Metric value={suspended} label="Suspended" />
      </div>
      <div className="card metric" style={{ maxWidth: 300 }}>
        <div className="value">{formatCurrency(revenueThisMonth)}</div>
        <div className="label">Revenue Collected This Month</div>
      </div>

      <div className="card">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>🔔 Notifications {notifications.length > 0 && <span className="badge overdue">{notifications.length}</span>}</h3>
          {notifications.length > 0 && <button className="btn secondary small" onClick={dismissAll}>Dismiss All</button>}
        </div>
        {notifications.length === 0 && <p className="muted mt-1">No unread notifications — you're caught up.</p>}
        {notifications.map((n) => (
          <div key={n.id} className="flex mt-1" style={{ justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #1e3a3d', paddingTop: 10 }}>
            <div>
              <span style={{ marginRight: 8 }}>{ICONS[n.type] || '🔔'}</span>
              {n.message}
              <div className="muted" style={{ fontSize: 12 }}>{new Date(n.created_at).toLocaleString()}</div>
            </div>
            <button className="btn secondary small" onClick={() => dismiss(n.id)}>Dismiss</button>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Metric, Alert } from '../components/ui.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import GettingStarted from '../components/GettingStarted.jsx';

export default function Dashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [summary, setSummary] = useState(null);
  const [products, setProducts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [recentMovements, setRecentMovements] = useState([]);

  const loadNotifications = () => api.get(`/stores/${user.storeId}/notifications`).then((r) => setNotifications(r.data.notifications.filter((n) => n.status === 'unread')));

  useEffect(() => {
    api.get(`/stores/${user.storeId}/analytics/summary`).then((r) => setSummary(r.data));
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    // Same /movements list the Movements page uses, already sorted newest
    // first by the backend — just take the first few for a glanceable panel.
    api.get(`/stores/${user.storeId}/movements`).then((r) => setRecentMovements(r.data.slice(0, 5)));
    loadNotifications();
    const interval = setInterval(loadNotifications, 60000);
    return () => clearInterval(interval);
  }, [user.storeId]);

  const dismissNotification = async (id) => {
    await api.patch(`/stores/${user.storeId}/notifications/${id}/read`);
    loadNotifications();
  };

  const lowStock = products.filter((p) => p.shelf_qty <= p.reorder_level);

  // A quick, owner-initiated snapshot sent over WhatsApp — deliberately
  // NOT an automated daily broadcast (that needs a real WhatsApp
  // Business API account, a separate integration this doesn't attempt).
  // This just prefills the message and opens WhatsApp, same mechanism
  // already used for invite sharing.
  const shareSummary = () => {
    if (!summary) return;
    const lines = [
      `*${user.storeName || 'Store'} — ${t('dashboard.statusUpdate')}*`,
      `${t('dashboard.totalProductsLine')}: ${summary.totalProducts}`,
      `${t('dashboard.stockValueLine')}: ${formatCurrency(summary.totalStockValue)}`,
      `${t('dashboard.lowStockLine')}: ${summary.lowStockCount}`,
    ];
    if (lowStock.length > 0) {
      lines.push('', t('dashboard.needsReordering'), ...lowStock.slice(0, 5).map((p) => `• ${p.name} (${p.shelf_qty} ${t('dashboard.itemsLeft')})`));
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');
  };

  return (
    <div>
      <div className="topbar">
        <div className="page-title">
          <h1>{t('dashboard.title')}</h1>
          <div className="sub">{t('dashboard.welcomeBack', { name: user.name })}</div>
        </div>
        <button className="btn secondary" onClick={shareSummary} disabled={!summary}>{t('dashboard.shareSummary')}</button>
      </div>
      <GettingStarted />

      {notifications.length > 0 && (
        <div className="card">
          {notifications.map((n) => (
            <Alert key={n.id} type={n.severity === 'amber' ? 'warning' : 'info'}>
              {n.severity === 'amber' ? '🟠' : 'ℹ️'} {n.message}
              <button className="btn secondary small" style={{ marginLeft: 12 }} onClick={() => dismissNotification(n.id)}>{t('dashboard.dismiss')}</button>
            </Alert>
          ))}
        </div>
      )}

      <div className="grid grid-4">
        <Metric value={summary?.totalProducts ?? '—'} label={t('dashboard.totalProducts')} />
        <Metric value={summary ? formatCurrency(summary.totalStockValue) : '—'} label={t('dashboard.totalStockValue')} />
        <Metric value={summary?.lowStockCount ?? '—'} label={t('dashboard.lowStockItems')} />
        <Metric value={summary?.pendingInvites ?? '—'} label={t('dashboard.pendingInvites')} />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="panel-header">
            <h3>{t('dashboard.lowStockAlerts')}</h3>
            <span className="count">{lowStock.length}</span>
          </div>
          {lowStock.length === 0 ? (
            <p className="muted">{t('dashboard.nothingBelowReorder')}</p>
          ) : (
            <div className="row-list">
              {lowStock.map((p) => (
                <div className="row-item" key={p.id}>
                  <div>
                    <div><strong>{p.name}</strong></div>
                    <div className="text-sm muted">{t('dashboard.stock')}: {p.shelf_qty} / {t('dashboard.reorder')}: {p.reorder_level}</div>
                  </div>
                  <span className="badge suspended">{t('dashboard.lowBadge')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="panel-header">
            <h3>{t('dashboard.recentMovements')}</h3>
            <span className="count">{recentMovements.length}</span>
          </div>
          {recentMovements.length === 0 ? (
            <p className="muted">{t('dashboard.noRecentMovements')}</p>
          ) : (
            <div className="row-list">
              {recentMovements.map((m) => (
                <div className="row-item" key={m.id}>
                  <div>
                    <div><strong>{m.product_name}</strong></div>
                    <div className="text-sm muted">{t(`movementsPage.types.${m.type}`, { defaultValue: m.type.replace(/_/g, ' ') })} × {m.quantity}</div>
                  </div>
                  <div className="text-sm muted">{new Date(m.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

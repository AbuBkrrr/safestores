import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, EmptyState } from '../components/ui.jsx';

const SYNC_EVENTS = ['arrival:created', 'movement:created'];

// Refrigerated/frozen goods spoil far faster than shelf-stable ones, so
// "urgent" means something different for each — matches the day bands in
// utils/batches.js's suggestedDiscountPct rather than a single flat scale.
function urgencyClass(daysUntilExpiry, storageType) {
  if (daysUntilExpiry < 0) return 'suspended'; // expired
  const isPerishable = storageType === 'refrigerated' || storageType === 'frozen';
  const urgentAt = isPerishable ? 2 : 7;
  const soonAt = isPerishable ? 5 : 14;
  if (daysUntilExpiry <= urgentAt) return 'suspended';
  if (daysUntilExpiry <= soonAt) return 'pending';
  return 'active';
}

export default function ExpiryTracking() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [batches, setBatches] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const STORAGE_LABEL = { ambient: null, refrigerated: t('expiryPage.refrigerated'), frozen: t('expiryPage.frozen') };
  function urgencyLabel(daysUntilExpiry, isExpired, storageType) {
    if (isExpired) return t('expiryPage.urgencyExpired');
    const isPerishable = storageType === 'refrigerated' || storageType === 'frozen';
    const urgentAt = isPerishable ? 2 : 7;
    const soonAt = isPerishable ? 5 : 14;
    if (daysUntilExpiry <= urgentAt) return t('expiryPage.urgencyUrgent');
    if (daysUntilExpiry <= soonAt) return t('expiryPage.urgencySoon');
    return t('expiryPage.urgencyMonitor');
  }

  const load = () => {
    // No `days` override — lets the backend apply each batch's own
    // storage-type-aware window (refrigerated/frozen look only ~10 days
    // out, ambient looks 30) rather than forcing one flat window that
    // would either bury urgent perishables or hide relevant ambient ones.
    api.get(`/stores/${user.storeId}/batches/expiring`)
      .then((r) => setBatches(r.data))
      .catch(() => setError(t('expiryPage.loadFailed')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  if (loading) return <div className="topbar"><h1>{t('expiryPage.title')}</h1></div>;

  return (
    <div>
      <div className="topbar"><h1>{t('expiryPage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>{t('expiryPage.batchesExpiring')}</h3>
        <p style={{ color: '#6b7c7d', marginTop: 0, marginBottom: 12 }}>
          {t('expiryPage.batchesDesc')}
        </p>
        {batches.length === 0 && <EmptyState>{t('expiryPage.nothingExpiring')}</EmptyState>}
        {batches.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('reportsPage.product')}</th><th>{t('expiryPage.batchNumber')}</th><th>{t('expiryPage.expiryDate')}</th><th>{t('expiryPage.daysLeft')}</th>
                <th>{t('expiryPage.remainingQty')}</th><th>{t('expiryPage.suggestedMarkdown')}</th><th>{t('expiryPage.status')}</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.productName} <span style={{ color: '#8aa5a8' }}>({b.sku})</span>
                    {STORAGE_LABEL[b.storageType] && (
                      <div><span className="muted" style={{ fontSize: 12 }}>{STORAGE_LABEL[b.storageType]}</span></div>
                    )}
                  </td>
                  <td>{b.batchNumber || '—'}</td>
                  <td>{new Date(b.expiryDate).toLocaleDateString()}</td>
                  <td>{b.isExpired ? t('expiryPage.daysAgo', { count: Math.abs(b.daysUntilExpiry) }) : t('expiryPage.daysCount', { count: b.daysUntilExpiry })}</td>
                  <td>{b.remaining}</td>
                  <td>{b.suggestedDiscountPct ? t('expiryPage.pctOff', { pct: b.suggestedDiscountPct }) : '—'}</td>
                  <td><span className={`badge ${urgencyClass(b.daysUntilExpiry, b.storageType)}`}>{urgencyLabel(b.daysUntilExpiry, b.isExpired, b.storageType)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

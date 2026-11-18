import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['cycle-count:created', 'product:updated'];

export default function CycleCounting() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [products, setProducts] = useState([]);
  const [accuracy, setAccuracy] = useState(null);
  const [history, setHistory] = useState([]);
  const [countingTask, setCountingTask] = useState(null); // task being counted, or null for ad-hoc
  const [adHocProductId, setAdHocProductId] = useState('');
  const [countedQty, setCountedQty] = useState('');
  const [autoAdjust, setAutoAdjust] = useState(true);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => {
    api.get(`/stores/${user.storeId}/cycle-counts/tasks`).then((r) => setTasks(r.data));
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    api.get(`/stores/${user.storeId}/cycle-counts/accuracy`).then((r) => setAccuracy(r.data));
    api.get(`/stores/${user.storeId}/cycle-counts/history`).then((r) => setHistory(r.data));
  };
  useEffect(() => { load(); }, [user.storeId]);

  useRealtimeEvents(SYNC_EVENTS, () => load());

  const startCount = (task) => {
    setCountingTask(task);
    setAdHocProductId('');
    setCountedQty('');
    setAutoAdjust(true);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const startAdHoc = () => {
    setCountingTask({ adhoc: true });
    setAdHocProductId('');
    setCountedQty('');
    setAutoAdjust(true);
    setError('');
  };

  const cancelCount = () => setCountingTask(null);

  const submitCount = async (e) => {
    e.preventDefault();
    setError('');
    const productId = countingTask.adhoc ? adHocProductId : countingTask.product_id;
    if (!productId || countedQty === '') { setError(t('cycleCountingPage.pickProductError')); return; }
    try {
      const { data } = await api.post(`/stores/${user.storeId}/cycle-counts`, {
        productId, countedQty: Number(countedQty), autoAdjust,
        taskId: countingTask.adhoc ? undefined : countingTask.id,
      });
      showToast(
        data.queued ? t('cycleCountingPage.savedOfflineToast') :
        data.discrepancy === 0 ? t('cycleCountingPage.noDiscrepancyToast') : t('cycleCountingPage.discrepancyToast', { sign: data.discrepancy > 0 ? '+' : '', value: data.discrepancy }),
        data.queued ? 'info' : (data.discrepancy === 0 ? 'success' : 'warning')
      );
      setCountingTask(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('cycleCountingPage.recordError'));
    }
  };

  const skipTask = async (id) => {
    await api.post(`/stores/${user.storeId}/cycle-counts/tasks/${id}/skip`);
    showToast(t('cycleCountingPage.taskSkippedToast'), 'info');
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>{t('cycleCountingPage.title')}</h1></div>
      <p className="muted mt-1" style={{ marginBottom: 16 }}>
        {t('cycleCountingPage.description')}
      </p>

      {accuracy && (
        <div className="grid grid-4">
          <div className="card metric"><div className="value">{tasks.length}</div><div className="label">{t('cycleCountingPage.tasksToday')}</div></div>
          <div className="card metric"><div className="value">{accuracy.accuracyRate === null ? '—' : `${accuracy.accuracyRate}%`}</div><div className="label">{t('cycleCountingPage.accuracy90Day')}</div></div>
          <div className="card metric"><div className="value">{accuracy.totalCounts}</div><div className="label">{t('cycleCountingPage.counts90Day')}</div></div>
          <div className="card metric"><div className="value">{accuracy.worstProducts.length}</div><div className="label">{t('cycleCountingPage.productsToWatchMetric')}</div></div>
        </div>
      )}

      {countingTask && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{countingTask.adhoc ? t('cycleCountingPage.adHocCount') : t('cycleCountingPage.countingProduct', { name: countingTask.product_name })}</h3>
          <Alert type="error">{error}</Alert>
          <form onSubmit={submitCount}>
            {countingTask.adhoc && (
              <div className="form-group">
                <label>{t('cycleCountingPage.product')}</label>
                <select value={adHocProductId} onChange={(e) => setAdHocProductId(e.target.value)} required>
                  <option value="">{t('cycleCountingPage.selectProduct')}</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                </select>
              </div>
            )}
            <div className="form-group">
              <label>{t('cycleCountingPage.countedQuantity')}</label>
              <input type="number" value={countedQty} onChange={(e) => setCountedQty(e.target.value)} required />
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
                <input type="checkbox" checked={autoAdjust} onChange={(e) => setAutoAdjust(e.target.checked)} style={{ width: 'auto' }} />
                {t('cycleCountingPage.autoAdjust')}
              </label>
            </div>
            <div className="flex">
              <button className="btn">{t('cycleCountingPage.submitCount')}</button>
              <button type="button" className="btn secondary" onClick={cancelCount}>{t('cycleCountingPage.cancel')}</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h3>{t('cycleCountingPage.todaysTasks')}</h3>
          <button className="btn small secondary" onClick={startAdHoc}>{t('cycleCountingPage.addAdHocCount')}</button>
        </div>
        {tasks.length === 0 && <EmptyState>{t('cycleCountingPage.noTasksDue')}</EmptyState>}
        {tasks.length > 0 && (
          <table>
            <thead><tr><th>{t('cycleCountingPage.product')}</th><th>{t('cycleCountingPage.priority')}</th><th>{t('cycleCountingPage.due')}</th><th>{t('cycleCountingPage.status')}</th><th></th></tr></thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.product_name} <span className="muted">({task.sku})</span></td>
                  <td>{t(`cycleCountingPage.tiers.${task.risk_tier}`)}</td>
                  <td className={task.status === 'overdue' ? 'muted' : ''} style={task.status === 'overdue' ? { color: 'var(--danger)' } : undefined}>
                    {task.due_date}{task.status === 'overdue' ? t('cycleCountingPage.overdue') : ''}
                  </td>
                  <td>{task.status}</td>
                  <td>
                    <div className="flex">
                      <button className="btn small" onClick={() => startCount(task)}>{t('cycleCountingPage.count')}</button>
                      <button className="btn small secondary" onClick={() => skipTask(task.id)}>{t('cycleCountingPage.skip')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {accuracy && accuracy.worstProducts.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('cycleCountingPage.productsToWatch')}</h3>
          <table>
            <thead><tr><th>{t('cycleCountingPage.product')}</th><th>{t('cycleCountingPage.counts')}</th><th>{t('cycleCountingPage.withDiscrepancy')}</th><th>{t('cycleCountingPage.avgDiscrepancy')}</th></tr></thead>
            <tbody>
              {accuracy.worstProducts.map((p) => (
                <tr key={p.productName}>
                  <td>{p.productName}</td>
                  <td>{p.countEvents}</td>
                  <td>{p.discrepancyEvents}</td>
                  <td>{p.avgAbsDiscrepancy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('cycleCountingPage.recentCounts')}</h3>
        {history.length === 0 && <EmptyState>{t('cycleCountingPage.noCountsYet')}</EmptyState>}
        {history.length > 0 && (
          <table>
            <thead><tr><th>{t('cycleCountingPage.product')}</th><th>{t('cycleCountingPage.counted')}</th><th>{t('cycleCountingPage.expected')}</th><th>{t('cycleCountingPage.discrepancy')}</th><th>{t('cycleCountingPage.by')}</th><th>{t('cycleCountingPage.when')}</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.product_name}</td>
                  <td>{h.counted_qty}</td>
                  <td>{h.expected_qty}</td>
                  <td style={h.discrepancy !== 0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                    {h.discrepancy > 0 ? '+' : ''}{h.discrepancy}
                  </td>
                  <td>{h.performed_by_name || '—'}</td>
                  <td className="muted">{new Date(h.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

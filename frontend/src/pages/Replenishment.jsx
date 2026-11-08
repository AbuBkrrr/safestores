import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Toast, Badge, EmptyState } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['purchase_order:created', 'purchase_order:received', 'product:updated'];

const PO_STATUS_BADGE = { draft: 'pending', sent: 'pending', received: 'active', cancelled: 'suspended' };

export default function Replenishment() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [suggestions, setSuggestions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState({}); // productId -> quantity, only for checked rows
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, showToast] = useToast();

  const load = () => {
    Promise.all([
      api.get(`/stores/${user.storeId}/replenishment/suggestions`),
      api.get(`/stores/${user.storeId}/replenishment/purchase-orders`),
    ])
      .then(([sugRes, poRes]) => { setSuggestions(sugRes.data); setOrders(poRes.data); })
      .catch(() => setError(t('replenishmentPage.loadFailed')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const toggleSelected = (s) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[s.productId] !== undefined) delete next[s.productId];
      else next[s.productId] = s.suggestedQty;
      return next;
    });
  };

  const setQty = (productId, qty) => {
    setSelected((prev) => ({ ...prev, [productId]: Number(qty) }));
  };

  const bySupplier = suggestions.reduce((acc, s) => {
    const key = s.supplier || 'Unspecified supplier';
    (acc[key] ||= []).push(s);
    return acc;
  }, {});

  const createOrderForSupplier = async (supplier, items) => {
    const chosen = items.filter((i) => selected[i.productId] !== undefined);
    if (chosen.length === 0) { showToast(t('replenishmentPage.selectAtLeastOne'), 'error'); return; }
    try {
      await api.post(`/stores/${user.storeId}/replenishment/purchase-orders`, {
        supplier,
        items: chosen.map((i) => ({ productId: i.productId, quantity: selected[i.productId] })),
      });
      setSelected({});
      showToast(t('replenishmentPage.poCreatedFor', { supplier }), 'success');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || t('replenishmentPage.poCreateFailed'), 'error');
    }
  };

  const toggleAutoReorder = async (productId, current) => {
    try {
      await api.put(`/stores/${user.storeId}/products/${productId}`, { autoReorder: !current });
      load();
    } catch {
      showToast(t('replenishmentPage.autoReorderFailed'), 'error');
    }
  };

  const poText = (po) => [
    t('replenishmentPage.poGreeting', { supplier: po.supplier || '' }),
    `${t('replenishmentPage.poFrom')}: ${user.storeName || ''}`,
    '',
    ...(po.items || []).map((i) => `• ${i.name} (${i.sku}) × ${i.quantity}`),
    '',
    t('replenishmentPage.poThanks'),
  ].join('\n');

  const printPo = (po) => {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = (po.items || []).map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td style="text-align:right">${i.quantity}</td><td style="text-align:right">${esc(formatCurrency(i.unit_cost))}</td><td style="text-align:right">${esc(formatCurrency(Number(i.unit_cost) * i.quantity))}</td></tr>`).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PO ${esc(po.id.slice(0, 8))}</title><style>body{font-family:Arial,sans-serif;padding:24px} table{width:100%;border-collapse:collapse;font-size:13px} th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left} h1{font-size:20px}</style></head><body>
      <h1>${esc(t('replenishmentPage.purchaseOrder'))} #${esc(po.id.slice(0, 8).toUpperCase())}</h1>
      <p><strong>${esc(user.storeName || '')}</strong><br>${esc(t('replenishmentPage.supplier'))}: ${esc(po.supplier || '')}<br>${new Date(po.created_at).toLocaleDateString()}</p>
      <table><thead><tr><th>SKU</th><th>${esc(t('replenishmentPage.items'))}</th><th>Qty</th><th>${esc(t('replenishmentPage.unitCost'))}</th><th>${esc(t('replenishmentPage.totalCost'))}</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="font-weight:700;text-align:right">${esc(t('replenishmentPage.totalCost'))}: ${esc(formatCurrency(po.total_cost))}</p></body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 200);
  };

  const sendOrder = async (id) => {
    try { await api.patch(`/stores/${user.storeId}/replenishment/purchase-orders/${id}/send`); load(); }
    catch (err) { showToast(err.response?.data?.error || t('replenishmentPage.sendFailed'), 'error'); }
  };
  const cancelOrder = async (id) => {
    try { await api.patch(`/stores/${user.storeId}/replenishment/purchase-orders/${id}/cancel`); load(); }
    catch (err) { showToast(err.response?.data?.error || t('replenishmentPage.cancelFailed'), 'error'); }
  };
  const receiveOrder = async (id) => {
    try {
      await api.post(`/stores/${user.storeId}/replenishment/purchase-orders/${id}/receive`, {});
      showToast(t('replenishmentPage.receivedUpdated'), 'success');
      load();
    } catch (err) { showToast(err.response?.data?.error || t('replenishmentPage.receiveFailed'), 'error'); }
  };

  if (loading) return <div className="topbar"><h1>{t('replenishmentPage.loadingTitle')}</h1></div>;

  return (
    <div>
      <div className="topbar"><h1>{t('replenishmentPage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>{t('replenishmentPage.suggestedReorders')}</h3>
        <p style={{ color: '#6b7c7d', marginTop: 0, marginBottom: 12 }}>
          {t('replenishmentPage.suggestedReordersDesc')}
        </p>
        {Object.keys(bySupplier).length === 0 && <EmptyState>{t('replenishmentPage.nothingNeedsReordering')}</EmptyState>}
        {Object.entries(bySupplier).map(([supplier, items]) => (
          <div key={supplier} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: '8px 0' }}>{supplier}</h4>
              <button className="btn" onClick={() => createOrderForSupplier(supplier, items)}>
                {t('replenishmentPage.createPurchaseOrder')}
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th></th><th>{t('replenishmentPage.product')}</th><th>{t('replenishmentPage.onHand')}</th><th>{t('replenishmentPage.reorderPoint')}</th>
                  <th>{t('replenishmentPage.velocityPerDay')}</th><th>{t('replenishmentPage.suggestedQty')}</th><th>{t('replenishmentPage.estCost')}</th><th>{t('replenishmentPage.auto')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.productId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected[s.productId] !== undefined}
                        onChange={() => toggleSelected(s)}
                      />
                    </td>
                    <td>{s.name} <span style={{ color: '#8aa5a8' }}>({s.sku})</span></td>
                    <td>{s.onHand}</td>
                    <td>{s.reorderPoint}</td>
                    <td>{s.velocityPerDay}</td>
                    <td>
                      {selected[s.productId] !== undefined ? (
                        <input
                          type="number"
                          min="1"
                          style={{ width: 70 }}
                          value={selected[s.productId]}
                          onChange={(e) => setQty(s.productId, e.target.value)}
                        />
                      ) : s.suggestedQty}
                    </td>
                    <td>{formatCurrency(s.estimatedCost)}</td>
                    <td>
                      <button
                        className={`btn small ${s.autoReorder ? '' : 'secondary'}`}
                        onClick={() => toggleAutoReorder(s.productId, s.autoReorder)}
                      >
                        {s.autoReorder ? t('replenishmentPage.on') : t('replenishmentPage.off')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('replenishmentPage.purchaseOrders')}</h3>
        {orders.length === 0 && <EmptyState>{t('replenishmentPage.noPurchaseOrders')}</EmptyState>}
        <table>
          <thead><tr><th>{t('replenishmentPage.supplier')}</th><th>{t('usersPage.status')}</th><th>{t('replenishmentPage.items')}</th><th>{t('replenishmentPage.totalCost')}</th><th>{t('replenishmentPage.created')}</th><th>{t('replenishmentPage.actions')}</th></tr></thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id}>
                <td>{po.supplier}{po.auto_generated ? ' 🤖' : ''}</td>
                <td><Badge status={PO_STATUS_BADGE[po.status] || po.status} /></td>
                <td>{po.items?.map((i) => `${i.name} x${i.quantity}`).join(', ')}</td>
                <td>{formatCurrency(po.total_cost)}</td>
                <td>{new Date(po.created_at).toLocaleString()}</td>
                <td>
                  <button className="btn small secondary" onClick={() => printPo(po)} title={t('replenishmentPage.printPo')}>📄</button>{' '}
                  <a className="btn small secondary" href={`https://wa.me/?text=${encodeURIComponent(poText(po))}`} target="_blank" rel="noreferrer" title={t('replenishmentPage.whatsappPo')}>💬</a>{' '}
                  {po.status === 'draft' && (
                    <>
                      <button className="btn small" onClick={() => sendOrder(po.id)}>{t('replenishmentPage.send')}</button>{' '}
                      <button className="btn small secondary" onClick={() => cancelOrder(po.id)}>{t('replenishmentPage.cancel')}</button>
                    </>
                  )}
                  {po.status === 'sent' && (
                    <>
                      <button className="btn small" onClick={() => receiveOrder(po.id)}>{t('replenishmentPage.markReceived')}</button>{' '}
                      <button className="btn small secondary" onClick={() => cancelOrder(po.id)}>{t('replenishmentPage.cancel')}</button>
                    </>
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

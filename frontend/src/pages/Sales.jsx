import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Badge, EmptyState, Modal, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import ReceiptView from '../components/ReceiptView.jsx';
import { methodLabel } from '../utils/receipt.js';

const CAN_REFUND = ['admin', 'manager'];
const PAGE = 50;

/** Sales history: find any receipt, reprint/share it, refund items. */
export default function Sales() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ q: '', from: '', to: '' });
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState(null);
  const [refund, setRefund] = useState(null); // { qty: {itemId: n}, restock: {itemId: bool}, method, reason }
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = (offset = 0) => api.get(`/stores/${user.storeId}/orders`, {
    params: { status: 'paid', q: filters.q || undefined, from: filters.from || undefined, to: filters.to || undefined, limit: PAGE, offset },
  }).then((r) => {
    const data = Array.isArray(r.data) ? r.data : [];
    setRows((prev) => (offset ? [...prev, ...data] : data));
    setMore(data.length === PAGE);
  });
  useEffect(() => { load(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id) => {
    const { data } = await api.get(`/stores/${user.storeId}/orders/${id}`);
    setSelected(data);
    setRefund(null);
  };

  const startRefund = () => setRefund({ qty: {}, restock: {}, method: 'cash', reason: '' });

  const submitRefund = async (e) => {
    e.preventDefault();
    setError('');
    const items = selected.items
      .filter((i) => Number(refund.qty[i.id]) > 0)
      .map((i) => ({ orderItemId: i.id, quantity: Number(refund.qty[i.id]), restock: refund.restock[i.id] !== false }));
    if (!items.length) { setError(t('salesPage.pickItems')); return; }
    try {
      const { data } = await api.post(`/stores/${user.storeId}/orders/${selected.id}/refunds`, { items, method: refund.method, reason: refund.reason || undefined });
      setSelected(data.order);
      setRefund(null);
      showToast(t('salesPage.refunded', { amount: formatCurrency(data.refund.amount) }), 'success');
      load(0);
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
  };

  return (
    <div>
      <div className="topbar"><div><h1>{t('salesPage.title')}</h1><p className="muted">{t('salesPage.subtitle')}</p></div></div>
      <Alert type="error">{error}</Alert>
      <div className="card">
        <form className="flex" onSubmit={(e) => { e.preventDefault(); load(0); }}>
          <input aria-label={t('salesPage.search')} placeholder={t('salesPage.searchPlaceholder')} value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} style={{ maxWidth: 220 }} />
          <label className="muted">{t('salesPage.from')} <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
          <label className="muted">{t('salesPage.to')} <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
          <button className="btn small">{t('common.search')}</button>
        </form>
        {rows.length === 0 ? <EmptyState>{t('salesPage.empty')}</EmptyState> : (
          <div className="table-wrap mt-1">
            <table>
              <thead><tr><th>{t('salesPage.receipt')}</th><th>{t('salesPage.when')}</th><th>{t('salesPage.cashier')}</th><th>{t('salesPage.method')}</th><th>{t('salesPage.items')}</th><th style={{ textAlign: 'right' }}>{t('checkout.total')}</th><th></th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td><code>{o.receipt_number}</code>{Number(o.refunded_total) > 0 && <> <Badge status="revoked" /></>}</td>
                    <td>{new Date(o.paid_at).toLocaleString()}</td>
                    <td>{o.paid_by_name || '—'}</td>
                    <td>{methodLabel(o.payment_method)}</td>
                    <td>{o.item_count}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(o.total)}{Number(o.refunded_total) > 0 && <div className="muted">−{formatCurrency(o.refunded_total)}</div>}</td>
                    <td><button className="btn small secondary" onClick={() => open(o.id)}>{t('salesPage.view')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && <button className="btn secondary mt-1" onClick={() => load(rows.length)}>{t('activityPage.loadMore')}</button>}
      </div>

      {selected && (
        <Modal title={selected.receipt_number} onClose={() => { setSelected(null); setRefund(null); }}>
          {!refund ? (
            <>
              <ReceiptView receipt={selected} onToast={showToast} />
              {CAN_REFUND.includes(user.role) && Number(selected.refunded_total) < Number(selected.total) && (
                <button className="btn danger mt-1" onClick={startRefund}>↩️ {t('salesPage.refund')}</button>
              )}
              {selected.refunds?.length > 0 && (
                <div className="mt-1">
                  <h4>{t('salesPage.refundHistory')}</h4>
                  {selected.refunds.map((r) => (
                    <p key={r.id} className="muted">{new Date(r.created_at).toLocaleString()} · {formatCurrency(r.amount)} · {methodLabel(r.method)} · {r.created_by_name}{r.reason ? ` · ${r.reason}` : ''}</p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <form onSubmit={submitRefund}>
              <p className="muted">{t('salesPage.refundIntro')}</p>
              {selected.items.map((i) => {
                const left = i.quantity - (i.refunded_qty || 0);
                return (
                  <div key={i.id} className="flex-between" style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
                    <span>{i.product_name} <span className="muted">({t('salesPage.canReturn', { count: left })})</span></span>
                    <span className="flex">
                      <input aria-label={`${t('salesPage.qtyToReturn')} ${i.product_name}`} type="number" min="0" max={left} disabled={left <= 0} value={refund.qty[i.id] || ''} onChange={(e) => setRefund({ ...refund, qty: { ...refund.qty, [i.id]: e.target.value } })} style={{ width: 70 }} />
                      <label className="muted"><input type="checkbox" checked={refund.restock[i.id] !== false} onChange={(e) => setRefund({ ...refund, restock: { ...refund.restock, [i.id]: e.target.checked } })} /> {t('salesPage.restock')}</label>
                    </span>
                  </div>
                );
              })}
              <div className="form-group mt-1">
                <label htmlFor="refund-method">{t('salesPage.refundMethod')}</label>
                <select id="refund-method" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>
                  {['cash', 'card', 'transfer', 'mobile_money', 'other', ...(selected.store_customer_id ? ['credit'] : [])].map((m) => <option key={m} value={m}>{m === 'credit' ? t('salesPage.storeCredit') : methodLabel(m)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="refund-reason">{t('salesPage.reason')}</label>
                <input id="refund-reason" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} placeholder={t('salesPage.reasonPlaceholder')} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setRefund(null)}>{t('common.cancel')}</button>
                <button className="btn danger">{t('salesPage.confirmRefund')}</button>
              </div>
            </form>
          )}
        </Modal>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

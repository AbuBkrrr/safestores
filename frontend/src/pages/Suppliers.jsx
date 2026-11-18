import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, EmptyState, Modal, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const emptyForm = { name: '', contactName: '', phone: '', email: '', notes: '' };

export default function Suppliers() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [suppliers, setSuppliers] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => {
    api.get(`/stores/${user.storeId}/suppliers`).then((r) => setSuppliers(r.data));
    api.get(`/stores/${user.storeId}/suppliers/pricing-alerts`).then((r) => setAlerts(r.data));
  };
  useEffect(() => { load(); }, [user.storeId]);

  const openCreate = () => { setForm(emptyForm); setCreating(true); };
  const openEdit = (s) => {
    setEditing(s);
    setForm({ name: s.name, contactName: s.contact_name || '', phone: s.phone || '', email: s.email || '', notes: s.notes || '' });
  };

  const submitCreate = async (e) => {
    e.preventDefault(); setError('');
    try {
      await api.post(`/stores/${user.storeId}/suppliers`, form);
      setCreating(false);
      showToast(t('suppliersPage.addedToast'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('suppliersPage.addError')); }
  };

  const submitEdit = async (e) => {
    e.preventDefault(); setError('');
    try {
      await api.patch(`/stores/${user.storeId}/suppliers/${editing.id}`, form);
      setEditing(null);
      showToast(t('suppliersPage.updatedToast'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('suppliersPage.updateError')); }
  };

  const remove = async (id) => {
    if (!window.confirm(t('suppliersPage.deleteConfirm'))) return;
    await api.delete(`/stores/${user.storeId}/suppliers/${id}`);
    showToast(t('suppliersPage.deletedToast'), 'success');
    load();
  };

  const openDetail = async (id) => {
    const { data } = await api.get(`/stores/${user.storeId}/suppliers/${id}/performance`);
    setDetail(data);
  };

  return (
    <div>
      <div className="topbar">
        <h1>{t('suppliersPage.title')}</h1>
        <button className="btn" onClick={openCreate}>{t('suppliersPage.addSupplier')}</button>
      </div>

      {alerts.length > 0 && (
        <Alert type="warning">
          {t('suppliersPage.pricingAlert', { count: alerts.length })}
        </Alert>
      )}

      <div className="card">
        {suppliers.length === 0 && <EmptyState>{t('suppliersPage.noSuppliersYet')}</EmptyState>}
        {suppliers.length > 0 && (
          <table>
            <thead><tr><th>{t('suppliersPage.name')}</th><th>{t('suppliersPage.contact')}</th><th>{t('suppliersPage.orders')}</th><th>{t('suppliersPage.onTimeRate')}</th><th>{t('suppliersPage.totalSpend')}</th><th></th></tr></thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                  </td>
                  <td>{s.contact_name || s.phone || s.email || '—'}</td>
                  <td>{s.total_orders}</td>
                  <td>{s.on_time_rate === null
                    ? '—'
                    : <span className={`badge ${s.on_time_rate >= 80 ? 'active' : s.on_time_rate >= 50 ? 'pending' : 'suspended'}`}>{s.on_time_rate}%</span>}</td>
                  <td>{formatCurrency(s.total_spend)}</td>
                  <td>
                    <div className="flex">
                      <button className="btn small secondary" onClick={() => openDetail(s.id)}>{t('suppliersPage.performance')}</button>
                      <button className="btn small secondary" onClick={() => openEdit(s)}>{t('suppliersPage.edit')}</button>
                      <button className="btn small danger" onClick={() => remove(s.id)}>{t('suppliersPage.delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {alerts.length > 0 && (
        <div className="card mt-2">
          <h3 style={{ marginBottom: 12 }}>{t('suppliersPage.betterPricingAvailable')}</h3>
          <table>
            <thead><tr><th>{t('suppliersPage.product')}</th><th>{t('suppliersPage.cheapestSupplier')}</th><th>{t('suppliersPage.cheapestPrice')}</th><th>{t('suppliersPage.mostExpensivePrice')}</th><th>{t('suppliersPage.potentialSavings')}</th></tr></thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.productId}>
                  <td>{a.productName}</td>
                  <td>{a.cheapestSupplierName}</td>
                  <td>{formatCurrency(a.cheapestCost)}</td>
                  <td>{formatCurrency(a.costliestCost)}</td>
                  <td>{a.savingsPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <Modal title={creating ? t('suppliersPage.addSupplierModalTitle') : t('suppliersPage.editModalTitle', { name: editing.name })} onClose={() => { setCreating(false); setEditing(null); }}>
          <Alert type="error">{error}</Alert>
          <form onSubmit={creating ? submitCreate : submitEdit}>
            <div className="form-group"><label>{t('suppliersPage.name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div className="form-group"><label>{t('suppliersPage.contactName')}</label>
              <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
            <div className="form-group"><label>{t('suppliersPage.phone')}</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="form-group"><label>{t('suppliersPage.email')}</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="form-group"><label>{t('suppliersPage.notes')}</label>
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => { setCreating(false); setEditing(null); }}>{t('suppliersPage.cancel')}</button>
              <button className="btn">{creating ? t('suppliersPage.addSupplier') : t('suppliersPage.saveChanges')}</button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={t('suppliersPage.performanceModalTitle', { name: detail.supplier.name })} onClose={() => setDetail(null)}>
          <div className="grid grid-4">
            <div className="card metric"><div className="value">{detail.totalOrders}</div><div className="label">{t('suppliersPage.totalOrders')}</div></div>
            <div className="card metric"><div className="value">{detail.onTimeRate === null ? '—' : `${detail.onTimeRate}%`}</div><div className="label">{t('suppliersPage.onTimeRate')}</div></div>
            <div className="card metric"><div className="value">{detail.lateOrders}</div><div className="label">{t('suppliersPage.lateDeliveries')}</div></div>
            <div className="card metric"><div className="value">{formatCurrency(detail.totalSpend)}</div><div className="label">{t('suppliersPage.totalSpend')}</div></div>
          </div>
          {detail.avgLateDays > 0 && <p className="muted mt-1">{t('suppliersPage.avgLateDays', { count: detail.avgLateDays })}</p>}

          {detail.betterPricingAlerts.length > 0 && (
            <div className="mt-2">
              <h3 style={{ marginBottom: 8 }}>{t('suppliersPage.cheaperElsewhere')}</h3>
              <table>
                <thead><tr><th>{t('suppliersPage.product')}</th><th>{t('suppliersPage.thisSupplier')}</th><th>{t('suppliersPage.cheaperOption')}</th><th>{t('suppliersPage.savings')}</th></tr></thead>
                <tbody>
                  {detail.betterPricingAlerts.map((a) => (
                    <tr key={a.productName}>
                      <td>{a.productName}</td>
                      <td>{formatCurrency(a.thisSupplierCost)}</td>
                      <td>{a.cheaperSupplierName} — {formatCurrency(a.cheaperCost)}</td>
                      <td>{a.savingsPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-2">
            <h3 style={{ marginBottom: 8 }}>{t('suppliersPage.recentOrders')}</h3>
            {detail.recentOrders.length === 0 && <EmptyState>{t('suppliersPage.noPurchaseOrdersYet')}</EmptyState>}
            {detail.recentOrders.length > 0 && (
              <table>
                <thead><tr><th>{t('suppliersPage.status')}</th><th>{t('suppliersPage.sent')}</th><th>{t('suppliersPage.received')}</th><th>{t('suppliersPage.cost')}</th></tr></thead>
                <tbody>
                  {detail.recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td><Badge status={o.status} /></td>
                      <td className="muted">{o.sent_at ? new Date(o.sent_at).toLocaleDateString() : '—'}</td>
                      <td className="muted">{o.received_at ? new Date(o.received_at).toLocaleDateString() : '—'}</td>
                      <td>{formatCurrency(o.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

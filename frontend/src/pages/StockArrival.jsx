import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['arrival:created', 'product:created', 'product:updated', 'product:deleted'];

export default function StockArrival() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [arrivals, setArrivals] = useState([]);
  const [form, setForm] = useState({ productId: '', quantity: '', invoiceNumber: '', expiryDate: '', batchNumber: '' });
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => {
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    api.get(`/stores/${user.storeId}/arrivals`).then((r) => setArrivals(r.data));
  };
  useEffect(() => { load(); }, [user.storeId]);

  // Another user recording an arrival, or a receipt/audit changing product
  // quantities, should show up here immediately without a manual reload.
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/stores/${user.storeId}/arrivals`, {
        ...form, quantity: Number(form.quantity),
      });
      setForm({ productId: '', quantity: '', invoiceNumber: '', expiryDate: '', batchNumber: '' });
      showToast(t('stockArrivalPage.recordedToast'), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('stockArrivalPage.recordError'));
    }
  };

  return (
    <div>
      <div className="topbar"><h1>{t('stockArrivalPage.title')}</h1></div>

      <div className="card">
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="grid grid-2">
            <div className="form-group">
              <label>{t('stockArrivalPage.product')}</label>
              <select value={form.productId} onChange={update('productId')} required>
                <option value="">{t('stockArrivalPage.selectProduct')}</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </select>
            </div>
            {(() => {
              // Packs/cartons → units: a product with pack_size > 1 can be
              // received by the carton; quantity is always stored in units.
              const sel = products.find((p) => p.id === form.productId);
              if (!sel || !(sel.pack_size > 1)) return null;
              return (
                <div className="form-group">
                  <label htmlFor="arr-packs">{t('stockArrivalPage.packsReceived', { unit: sel.pack_unit || t('products.pack'), size: sel.pack_size })}</label>
                  <input id="arr-packs" type="number" min="0" onChange={(e) => setForm({ ...form, quantity: String((Number(e.target.value) || 0) * sel.pack_size) })} />
                </div>
              );
            })()}
            <div className="form-group"><label>{t('stockArrivalPage.quantityReceived')}</label><input type="number" min="1" value={form.quantity} onChange={update('quantity')} required /></div>
            <div className="form-group"><label>{t('stockArrivalPage.invoiceNumber')}</label><input value={form.invoiceNumber} onChange={update('invoiceNumber')} /></div>
            <div className="form-group"><label>{t('stockArrivalPage.expiryDate')}</label><input type="date" value={form.expiryDate} onChange={update('expiryDate')} /></div>
            <div className="form-group"><label>{t('stockArrivalPage.batchNumber')}</label><input value={form.batchNumber} onChange={update('batchNumber')} placeholder={t('stockArrivalPage.batchPlaceholder')} /></div>
          </div>
          <button className="btn">{t('stockArrivalPage.recordArrival')}</button>
        </form>
      </div>

      <div className="card">
        <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('stockArrivalPage.arrivalHistory')}</h3>
        <table>
          <thead><tr><th>{t('stockArrivalPage.product')}</th><th>{t('stockArrivalPage.qty')}</th><th>{t('stockArrivalPage.invoice')}</th><th>{t('stockArrivalPage.expiry')}</th><th>{t('stockArrivalPage.batch')}</th><th>{t('stockArrivalPage.date')}</th></tr></thead>
          <tbody>
            {arrivals.map((a) => (
              <tr key={a.id}>
                <td>{a.product_name}</td><td>{a.quantity}</td><td>{a.invoice_number || '—'}</td>
                <td>{a.expiry_date ? new Date(a.expiry_date).toLocaleDateString() : '—'}</td>
                <td>{a.batch_number || '—'}</td>
                <td>{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

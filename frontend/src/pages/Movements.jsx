import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['movement:created', 'product:created', 'product:updated', 'product:deleted'];

// Option order/values stay hardcoded (the API expects these exact
// `type` strings); only the displayed label is looked up per language
// via movementsPage.types.<value> in the component below.
const TYPE_VALUES = ['transfer_to_shelf', 'sale', 'damage', 'expiry', 'adjustment'];

export default function Movements() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [form, setForm] = useState({ productId: '', type: 'transfer_to_shelf', quantity: '', note: '' });
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => {
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    api.get(`/stores/${user.storeId}/movements`).then((r) => setMovements(r.data));
  };
  useEffect(() => { load(); }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/stores/${user.storeId}/movements`, { ...form, quantity: Number(form.quantity) });
      setForm({ productId: '', type: 'transfer_to_shelf', quantity: '', note: '' });
      showToast(t('movementsPage.recordedToast'), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('movementsPage.recordError'));
    }
  };

  return (
    <div>
      <div className="topbar"><h1>{t('movementsPage.title')}</h1></div>

      <div className="card">
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="grid grid-2">
            <div className="form-group">
              <label>{t('movementsPage.product')}</label>
              <select value={form.productId} onChange={update('productId')} required>
                <option value="">{t('movementsPage.selectProduct')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{t('movementsPage.productOption', { name: p.name, backroom: p.backroom_qty, shelf: p.shelf_qty })}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('movementsPage.movementType')}</label>
              <select value={form.type} onChange={update('type')}>
                {TYPE_VALUES.map((v) => <option key={v} value={v}>{t(`movementsPage.types.${v}`)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>{t('movementsPage.quantity')} {form.type === 'adjustment' && t('movementsPage.quantityAdjustmentHint')}</label>
              <input type="number" value={form.quantity} onChange={update('quantity')} required />
            </div>
            <div className="form-group"><label>{t('movementsPage.note')}</label><input value={form.note} onChange={update('note')} /></div>
          </div>
          <button className="btn">{t('movementsPage.recordMovement')}</button>
        </form>
      </div>

      <div className="card">
        <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('movementsPage.movementHistory')}</h3>
        <table>
          <thead><tr><th>{t('movementsPage.product')}</th><th>{t('movementsPage.type')}</th><th>{t('movementsPage.qty')}</th><th>{t('movementsPage.note')}</th><th>{t('movementsPage.date')}</th></tr></thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{m.product_name}</td><td>{t(`movementsPage.types.${m.type}`, { defaultValue: m.type.replace(/_/g, ' ') })}</td><td>{m.quantity}</td>
                <td>{m.note || '—'}</td><td>{new Date(m.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

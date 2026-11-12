import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const SYNC_EVENTS = ['product:created', 'product:updated', 'product:deleted', 'arrival:created', 'movement:created', 'audit:created'];
const NEW_ARRIVAL_DAYS = 3;

function isNewArrival(lastArrivalAt) {
  if (!lastArrivalAt) return false;
  const ageMs = Date.now() - new Date(lastArrivalAt).getTime();
  return ageMs <= NEW_ARRIVAL_DAYS * 24 * 60 * 60 * 1000;
}

// image_url is stored root-relative (e.g. "/uploads/xyz.jpg"), served by
// the same server as the API but NOT under the /api prefix — so when
// VITE_API_URL points elsewhere (e.g. a mobile build hitting a remote
// server), that prefix needs stripping before joining the path.
function buildUploadUrl(imageUrl) {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) return imageUrl; // same-origin — root-relative path resolves correctly as-is
  return apiUrl.replace(/\/api\/?$/, '') + imageUrl;
}

const empty = {
  name: '', sku: '', category: '', supplier: '', unit: 'unit', location: '', storageType: 'ambient',
  costPrice: '', priceMultiplier: '1.3', reorderLevel: '5', initialBackroomQty: '0',
  leadTimeDays: '7', minOrderQty: '1', autoReorder: false,
  barcode: '', packSize: '1', packUnit: '', variantOf: '', variantLabel: '',
};

export default function Products() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const [showForm, setShowForm] = useState(false);
  const [locationDrafts, setLocationDrafts] = useState({});

  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');

  const load = () => api.get(`/stores/${user.storeId}/products${showArchived ? '?includeArchived=true' : ''}`).then((r) => setProducts(r.data));
  useEffect(() => { load(); }, [user.storeId, showArchived]);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  // Location can be set at creation time or edited inline later — most
  // stores will be tagging an existing product list with shelf/section
  // info retroactively, not just new products going forward.
  const locationValue = (p) => (locationDrafts[p.id] !== undefined ? locationDrafts[p.id] : (p.location || ''));
  const handleLocationInput = (id, value) => setLocationDrafts((d) => ({ ...d, [id]: value }));
  const saveLocation = async (p) => {
    const value = locationDrafts[p.id];
    if (value === undefined || value === (p.location || '')) return;
    await api.put(`/stores/${user.storeId}/products/${p.id}`, { location: value });
    setLocationDrafts((d) => { const n = { ...d }; delete n[p.id]; return n; });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/stores/${user.storeId}/products`, form);
      setForm(empty); setShowForm(false);
      showToast(t('products.productCreatedToast'), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('products.createError'));
    }
  };

  const handleDelete = async (id) => {
    if (!confirm(t('products.archiveConfirm'))) return;
    await api.delete(`/stores/${user.storeId}/products/${id}`);
    load();
  };

  const handleRestore = async (id) => {
    await api.patch(`/stores/${user.storeId}/products/${id}/restore`);
    load();
  };

  return (
    <div>
      <div className="topbar">
        <h1>{t('products.title')}</h1>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginRight: 12 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t('products.showArchived')}
        </label>
        {['admin', 'manager'].includes(user.role) && <Link className="btn secondary small" to="/products/import">⬆️ {t('products.import')}</Link>}
        <Link className="btn secondary small" to="/labels">🏷️ {t('products.labels')}</Link>
        <button className="btn" onClick={() => setShowForm((s) => !s)}>{showForm ? t('products.cancel') : t('products.newProduct')}</button>
      </div>

      {showForm && (
        <div className="card">
          <Alert type="error">{error}</Alert>
          <form onSubmit={handleCreate}>
            <div className="grid grid-2">
              <div className="form-group"><label>{t('products.name')}</label><input value={form.name} onChange={update('name')} required /></div>
              <div className="form-group"><label>{t('products.skuOrBarcode')}</label><input value={form.sku} onChange={update('sku')} required /></div>
              <div className="form-group"><label htmlFor="pf-barcode">{t('products.barcode')}</label><input id="pf-barcode" value={form.barcode} onChange={update('barcode')} placeholder={t('products.barcodePlaceholder')} /></div>
              <div className="form-group">
                <label htmlFor="pf-variant">{t('products.variantOf')}</label>
                <select id="pf-variant" value={form.variantOf} onChange={update('variantOf')}>
                  <option value="">{t('products.notAVariant')}</option>
                  {products.filter((p) => !p.variant_of && !p.archived_at).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              {form.variantOf && <div className="form-group"><label htmlFor="pf-vlabel">{t('products.variantLabel')}</label><input id="pf-vlabel" value={form.variantLabel} onChange={update('variantLabel')} placeholder={t('products.variantLabelPlaceholder')} /></div>}
              <div className="form-group"><label htmlFor="pf-pack">{t('products.packSize')}</label><input id="pf-pack" type="number" min="1" value={form.packSize} onChange={update('packSize')} /><span className="help-text">{t('products.packSizeHelp')}</span></div>
              <div className="form-group"><label htmlFor="pf-packunit">{t('products.packUnit')}</label><input id="pf-packunit" value={form.packUnit} onChange={update('packUnit')} placeholder={t('products.packUnitPlaceholder')} /></div>
              <div className="form-group"><label>{t('products.category')}</label><input value={form.category} onChange={update('category')} /></div>
              <div className="form-group"><label>{t('products.supplier')}</label><input value={form.supplier} onChange={update('supplier')} /></div>
              <div className="form-group"><label>{t('products.unit')}</label><input value={form.unit} onChange={update('unit')} /></div>
              <div className="form-group">
                <label>{t('products.location')}</label>
                <input placeholder={t('products.locationPlaceholder')} value={form.location} onChange={update('location')} />
              </div>
              <div className="form-group">
                <label>{t('products.storageType')}</label>
                <select value={form.storageType} onChange={update('storageType')}>
                  <option value="ambient">{t('products.ambient')}</option>
                  <option value="refrigerated">{t('products.refrigerated')}</option>
                  <option value="frozen">{t('products.frozen')}</option>
                </select>
              </div>
              <div className="form-group"><label>{t('products.costPrice')}</label><input type="number" step="0.01" value={form.costPrice} onChange={update('costPrice')} required /></div>
              <div className="form-group">
                <label htmlFor="pf-sell">{t('products.sellingPrice')}</label>
                <input id="pf-sell" type="number" step="0.01" min="0"
                  value={form.costPrice && form.priceMultiplier ? String(Math.round(Number(form.costPrice) * Number(form.priceMultiplier) * 100) / 100) : ''}
                  onChange={(e) => setForm({ ...form, priceMultiplier: Number(form.costPrice) > 0 ? String(Number(e.target.value) / Number(form.costPrice)) : form.priceMultiplier })}
                  disabled={!(Number(form.costPrice) > 0)} />
                <span className="help-text">{Number(form.costPrice) > 0 ? t('products.markupHelp', { pct: Math.round((Number(form.priceMultiplier) - 1) * 1000) / 10 }) : t('products.enterCostFirst')}</span>
              </div>
              <div className="form-group"><label>{t('products.reorderLevel')}</label><input type="number" value={form.reorderLevel} onChange={update('reorderLevel')} /></div>
              <div className="form-group"><label>{t('products.initialBackroomQty')}</label><input type="number" value={form.initialBackroomQty} onChange={update('initialBackroomQty')} /></div>
              <div className="form-group"><label>{t('products.leadTimeDays')}</label><input type="number" value={form.leadTimeDays} onChange={update('leadTimeDays')} /></div>
              <div className="form-group"><label>{t('products.minOrderQty')}</label><input type="number" value={form.minOrderQty} onChange={update('minOrderQty')} /></div>
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={form.autoReorder}
                    onChange={(e) => setForm({ ...form, autoReorder: e.target.checked })}
                  />{' '}
                  {t('products.autoReorder')}
                </label>
              </div>
            </div>
            <button className="btn">{t('products.saveProduct')}</button>
          </form>
        </div>
      )}

      <div className="card">
        <input aria-label={t('common.search')} placeholder={t('products.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} />
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('products.name')}</th><th>{t('products.sku')}</th><th>{t('products.category')}</th><th>{t('products.location_')}</th><th>{t('products.cost')}</th><th>{t('products.sellPrice')}</th>
              <th>{t('products.backroom')}</th><th>{t('products.shelf')}</th><th>{t('products.stockValue')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {products.filter((p) => {
              const q = query.trim().toLowerCase();
              return !q || [p.name, p.sku, p.barcode, p.category, p.variant_label].some((v) => v && String(v).toLowerCase().includes(q));
            }).map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {p.variant_label && <span className="muted"> · {p.variant_label}</span>}
                  {p.pack_size > 1 && <span className="muted" title={t('products.packSize')}> · {p.pack_size}/{p.pack_unit || t('products.pack')}</span>}
                  {p.storage_type === 'frozen' && <span title={t('products.frozenTitle')}> 🧊</span>}
                  {p.storage_type === 'refrigerated' && <span title={t('products.refrigeratedTitle')}> ❄️</span>}
                  {p.shelf_qty <= p.reorder_level && <span title={t('products.lowStockTitle')}> ⚠️</span>}
                  {isNewArrival(p.last_arrival_at) && (
                    <div className="mt-1">
                      <span className="badge active" title={`${t('products.newArrival')} ${new Date(p.last_arrival_at).toLocaleString()}`}>
                        {t('products.newArrival')} · {new Date(p.last_arrival_at).toLocaleDateString()}
                      </span>
                      {p.last_arrival_receipt_image && (
                        <a href={buildUploadUrl(p.last_arrival_receipt_image)} target="_blank" rel="noreferrer" className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                          {t('products.viewScannedReceipt')}
                        </a>
                      )}
                    </div>
                  )}
                </td>
                <td><span className="code-chip">{p.sku}</span>{p.barcode && p.barcode !== p.sku && <div className="muted" style={{ fontSize: 11 }}>{p.barcode}</div>}</td>
                <td>{p.category || '—'}</td>
                <td>
                  <input
                    placeholder={t('products.notSet')}
                    value={locationValue(p)}
                    onChange={(e) => handleLocationInput(p.id, e.target.value)}
                    onBlur={() => saveLocation(p)}
                    style={{ minWidth: 140, fontSize: 13 }}
                  />
                </td>
                <td>{formatCurrency(p.cost_price)}</td>
                <td>{formatCurrency(p.selling_price)}</td>
                <td>{p.backroom_qty}</td>
                <td>{p.shelf_qty}</td>
                <td>{formatCurrency(p.stock_value)}</td>
                <td>
                  {p.archived_at
                    ? <button className="btn small" onClick={() => handleRestore(p.id)}>{t('products.restore')}</button>
                    : <button className="btn danger small" onClick={() => handleDelete(p.id)}>{t('products.archive')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

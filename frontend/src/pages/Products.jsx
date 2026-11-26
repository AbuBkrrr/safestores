import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { useStoreProfile } from '../utils/useStoreTier.js';
import { BUSINESS_TYPES, SOLD_BY_UNITS, fmtQty } from '../utils/businessTypes.js';
import { mediaUrl } from '../utils/media.js';
import { lookOfFile, packLook } from '../utils/visualMatch.js';
import QuickAddProduct from '../components/QuickAddProduct.jsx';
import PromoDialog from '../components/PromoDialog.jsx';

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
  name: '', sku: '', category: '', supplier: '', unit: 'unit', location: '', storageType: 'ambient', soldBy: 'unit', shelfLifeDays: '',
  costPrice: '', priceMultiplier: '1.3', reorderLevel: '5', initialBackroomQty: '0',
  leadTimeDays: '7', minOrderQty: '1', autoReorder: false,
  barcode: '', packSize: '1', packUnit: '', variantOf: '', variantLabel: '',
};

export default function Products() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [products, setProducts] = useState([]);
  const { businessType, tools, tier: storeTier } = useStoreProfile();
  const bt = BUSINESS_TYPES[businessType] || BUSINESS_TYPES.general;
  const typeDefaults = { soldBy: bt.soldBy, unit: bt.unit, shelfLifeDays: bt.shelfLifeDays ? String(bt.shelfLifeDays) : '' };
  const [form, setForm] = useState(empty);
  useEffect(() => { setForm((f) => (f.name ? f : { ...f, ...typeDefaults })); }, [businessType]); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const [showForm, setShowForm] = useState(false);
  const [locationDrafts, setLocationDrafts] = useState({});

  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');

  const [quick, setQuick] = useState(() => new URLSearchParams(window.location.search).get('quick') === '1');
  const [putOnShelf, setPutOnShelf] = useState(true);
  const [promoFor, setPromoFor] = useState(null);
  // One tap: store-room stock onto the shelf (one product, or all of them).
  const canShelf = ['admin', 'manager', 'store_manager', 'shelf_manager'].includes(user?.role);
  const simple = storeTier === 'mini'; // fewer columns for a one-person shop
  const toShelf = async (ids) => {
    try {
      const r = await api.post(`/stores/${user.storeId}/products/to-shelf`, ids ? { productIds: ids } : {});
      showToast(t('products.movedToShelf', { count: r.data.moved }), 'success');
      load();
    } catch (err) { showToast(err.response?.data?.error || t('common.errorGeneric'), 'error'); }
  };
  const load = () => api.get(`/stores/${user.storeId}/products${showArchived ? '?includeArchived=true' : ''}`).then((r) => setProducts(r.data));
  useEffect(() => { load(); }, [user.storeId, showArchived]);
  // Arriving from a scan (Import Products → Scan): open the new-product form with the barcode filled in.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const code = params.get('barcode');
    if (!code) return;
    setForm((f) => ({ ...f, barcode: code, sku: f.sku || code }));
    setShowForm(true);
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  // Location can be set at creation time or edited inline later — most
  // stores will be tagging an existing product list with shelf/section
  // info retroactively, not just new products going forward.
  const locationValue = (p) => (locationDrafts[p.id] !== undefined ? locationDrafts[p.id] : (p.location || ''));
  const handleLocationInput = (id, value) => setLocationDrafts((d) => ({ ...d, [id]: value }));
  // Item photos: a quick picture so look-alike products are easy to tell apart.
  const canPhoto = ['admin', 'manager', 'store_manager', 'shelf_manager'].includes(user?.role);
  const photoInput = useRef(null);
  const [photoFor, setPhotoFor] = useState(null);
  const pickPhoto = (p) => { setPhotoFor(p); photoInput.current?.click(); };
  const uploadPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !photoFor) return;
    const fd = new FormData();
    fd.append('photo', file);
    try {
      const r = await api.post(`/stores/${user.storeId}/products/${photoFor.id}/photo`, fd);
      setProducts((list) => list.map((x) => (x.id === r.data.id ? { ...x, image_url: r.data.image_url } : x)));
      showToast(t('products.photoSaved'), 'success');
      // The photo also teaches the till camera what this item looks like.
      const look = await lookOfFile(file);
      if (look) api.post(`/stores/${user.storeId}/products/${photoFor.id}/looks`, { sig: packLook(look) }).catch(() => {});
    } catch (err) { showToast(err.response?.data?.error || t('products.photoFailed'), 'error'); }
  };
  const removePhoto = async (p) => {
    try {
      await api.delete(`/stores/${user.storeId}/products/${p.id}/photo`);
      setProducts((list) => list.map((x) => (x.id === p.id ? { ...x, image_url: null } : x)));
    } catch (err) { showToast(err.response?.data?.error || t('products.photoFailed'), 'error'); }
  };

  // Profit % for many products at once: all, one category, or ticked ones.
  const canPrice = ['admin', 'manager'].includes(user?.role);
  const [markup, setMarkup] = useState(null); // { scope, category, percent }
  const [ticked, setTicked] = useState(() => new Set());
  const allCategories = [...new Set(products.map((p) => p.category).filter(Boolean))].sort();
  const toggleTick = (id) => setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const markupCount = !markup ? 0 : markup.scope === 'all' ? products.filter((p) => !p.archived_at).length
    : markup.scope === 'category' ? products.filter((p) => p.category === markup.category && !p.archived_at).length : ticked.size;
  const applyMarkup = async () => {
    try {
      const r = await api.post(`/stores/${user.storeId}/products/markup`, {
        scope: markup.scope, category: markup.category, percent: Number(markup.percent), productIds: [...ticked],
      });
      showToast(t('markup.done', { count: r.data.updated, pct: r.data.percent }), 'success');
      setMarkup(null); setTicked(new Set());
      const fresh = await api.get(`/stores/${user.storeId}/products`); setProducts(fresh.data);
    } catch (err) { showToast(err.response?.data?.error || t('markup.failed'), 'error'); }
  };

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
      await api.post(`/stores/${user.storeId}/products`, { ...form, putOnShelf: putOnShelf ? form.initialBackroomQty : 0 });
      setForm({ ...empty, ...typeDefaults }); setShowForm(false);
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
        {!simple && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginRight: 12 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            {t('products.showArchived')}
          </label>
        )}
        {!simple && ['admin', 'manager'].includes(user.role) && <Link className="btn secondary small" to="/products/import">⬆️ {t('products.import')}</Link>}
        <Link className="btn secondary small" to="/labels">🏷️ {t('products.labels')}</Link>
        {['admin', 'manager', 'store_manager'].includes(user.role) && <button className="btn" onClick={() => { setQuick((q) => !q); setShowForm(false); }}>⚡ {t('quickAdd.button')}</button>}
        <button className="btn secondary" onClick={() => { setShowForm((s) => !s); setQuick(false); }}>{showForm ? t('products.cancel') : t('products.newProduct')}</button>
      </div>

      {canShelf && products.some((x) => Number(x.backroom_qty) > 0 && !x.archived_at) && (
        <div className="alert info flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>📦 {t('products.inStoreRoomBanner', { count: products.filter((x) => Number(x.backroom_qty) > 0 && !x.archived_at).length })}</span>
          <button type="button" className="btn small" onClick={() => toShelf(null)}>➜ {t('products.allToShelf')}</button>
        </div>
      )}

      {quick && (
        <QuickAddProduct storeId={user.storeId} autoShelf={storeTier === 'mini'} defaultUnit={bt.unit === 'unit' ? 'piece' : bt.unit}
          categories={[...new Set([...(bt.categories || []), ...products.map((x) => x.category).filter(Boolean)])]}
          onAdded={(p) => setProducts((list) => [p, ...list])} onClose={() => setQuick(false)} />
      )}

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
              <div className="form-group"><label>{t('products.category')}</label><input value={form.category} onChange={update('category')} list="pf-cats" />
                <datalist id="pf-cats">{[...new Set([...bt.categories, ...products.map((p) => p.category).filter(Boolean)])].sort().map((c) => <option key={c} value={c} />)}</datalist></div>
              <div className="form-group"><label>{t('products.supplier')}</label><input value={form.supplier} onChange={update('supplier')} /></div>
              <div className="form-group"><label htmlFor="pf-soldby">{t('products.soldBy')}</label>
                <select id="pf-soldby" value={form.soldBy} onChange={(e) => setForm({ ...form, soldBy: e.target.value, unit: SOLD_BY_UNITS[e.target.value][0] })}>
                  {Object.keys(SOLD_BY_UNITS).map((k) => <option key={k} value={k}>{t(`products.soldBy_${k}`)}</option>)}
                </select></div>
              <div className="form-group"><label htmlFor="pf-unit">{t('products.unit')}</label><input id="pf-unit" value={form.unit} onChange={update('unit')} list="pf-units" />
                <datalist id="pf-units">{SOLD_BY_UNITS[form.soldBy || 'unit'].map((u) => <option key={u} value={u} />)}</datalist></div>
              {(tools.includes('fresh') || form.storageType !== 'ambient') && (
                <div className="form-group"><label htmlFor="pf-shelf">{t('products.shelfLifeDays')}</label><input id="pf-shelf" type="number" min="1" value={form.shelfLifeDays} onChange={update('shelfLifeDays')} placeholder={t('products.shelfLifePh')} /></div>
              )}
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
              <div className="form-group"><label>{t('products.initialBackroomQty')}</label><input type="number" value={form.initialBackroomQty} onChange={update('initialBackroomQty')} />
                <label className="flex small" style={{ alignItems: 'center', gap: 6, marginTop: 6 }}><input type="checkbox" checked={putOnShelf} onChange={(e) => setPutOnShelf(e.target.checked)} /> {t('quickAdd.onShelf')}</label></div>
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
        {canPrice && !markup && <div className="flex" style={{ justifyContent: 'flex-end', marginBottom: 10 }}><button type="button" className="btn secondary small" onClick={() => setMarkup({ scope: 'all', category: allCategories[0] || '', percent: '' })}>💹 {t('markup.open')}</button></div>}
        {canPrice && markup && (
          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>💹 {t('markup.title')}</h3>
            <div className="flex" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ margin: 0 }}><label htmlFor="mk-scope">{t('markup.applyTo')}</label>
                <select id="mk-scope" value={markup.scope} onChange={(e) => setMarkup({ ...markup, scope: e.target.value })}>
                  <option value="all">{t('markup.all')}</option>
                  <option value="category">{t('markup.category')}</option>
                  <option value="products">{t('markup.ticked')}</option>
                </select></div>
              {markup.scope === 'category' && <div className="form-group" style={{ margin: 0 }}><label htmlFor="mk-cat">{t('markup.whichCategory')}</label>
                <select id="mk-cat" value={markup.category} onChange={(e) => setMarkup({ ...markup, category: e.target.value })}>{allCategories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>}
              <div className="form-group" style={{ margin: 0 }}><label htmlFor="mk-pct">{t('markup.percent')}</label>
                <input id="mk-pct" type="number" min="0" max="1000" step="0.5" value={markup.percent} onChange={(e) => setMarkup({ ...markup, percent: e.target.value })} style={{ width: 110 }} /></div>
              <button type="button" className="btn" disabled={markup.percent === '' || !markupCount} onClick={applyMarkup}>{t('markup.apply', { count: markupCount })}</button>
              <button type="button" className="btn secondary" onClick={() => { setMarkup(null); setTicked(new Set()); }}>{t('common.cancel')}</button>
            </div>
            <p className="help-text">{markup.scope === 'products' ? t('markup.tickHelp') : t('markup.help')}</p>
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>{t('products.name')}</th>{!simple && <th>{t('products.sku')}</th>}<th>{t('products.category')}</th>{!simple && <th>{t('products.location_')}</th>}<th>{t('products.cost')}</th><th>{t('products.sellPrice')}</th>
              <th>{t('products.backroom')}</th><th>{t('products.shelf')}</th>{!simple && <th>{t('products.stockValue')}</th>}<th></th>
            </tr>
          </thead>
          <tbody>
            {canPhoto && <tr hidden><td><input ref={photoInput} type="file" accept="image/*" capture="environment" onChange={uploadPhoto} aria-label={t('products.addPhoto')} /></td></tr>}
            {products.filter((p) => {
              const q = query.trim().toLowerCase();
              return !q || [p.name, p.sku, p.barcode, p.category, p.variant_label].some((v) => v && String(v).toLowerCase().includes(q));
            }).map((p) => (
              <tr key={p.id}>
                <td>
                  {markup?.scope === 'products' && <input type="checkbox" checked={ticked.has(p.id)} onChange={() => toggleTick(p.id)} aria-label={t('markup.tickFor', { name: p.name })} style={{ marginRight: 8 }} />}
                  <span className="prod-thumb-wrap">
                    {p.image_url
                      ? <img className="prod-thumb" src={mediaUrl(p.image_url)} alt="" loading="lazy" />
                      : <span className="prod-thumb prod-thumb-empty" aria-hidden="true">📷</span>}
                    {canPhoto && (
                      <span className="prod-thumb-actions">
                        <button type="button" className="link-btn" onClick={() => pickPhoto(p)}>{p.image_url ? t('products.changePhoto') : t('products.addPhoto')}</button>
                        {p.image_url && <button type="button" className="link-btn" onClick={() => removePhoto(p)} aria-label={t('products.removePhotoFor', { name: p.name })}>✕</button>}
                      </span>
                    )}
                  </span>
                  {p.name}
                  {p.variant_label && <span className="muted"> · {p.variant_label}</span>}
                  {p.sold_by && p.sold_by !== 'unit' && <span className="muted"> · {t('products.perUnit', { unit: p.unit })}</span>}{p.pack_size > 1 && <span className="muted" title={t('products.packSize')}> · {p.pack_size}/{p.pack_unit || t('products.pack')}</span>}
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
                {!simple && <td><span className="code-chip">{p.sku}</span>{p.barcode && p.barcode !== p.sku && <div className="muted" style={{ fontSize: 11 }}>{p.barcode}</div>}</td>}
                <td>{p.category || '—'}</td>
                {!simple && <td>
                  <input
                    placeholder={t('products.notSet')}
                    value={locationValue(p)}
                    onChange={(e) => handleLocationInput(p.id, e.target.value)}
                    onBlur={() => saveLocation(p)}
                    style={{ minWidth: 140, fontSize: 13 }}
                  />
                </td>}
                <td>{formatCurrency(p.cost_price)}</td>
                <td>
                  {formatCurrency(p.selling_price)}
                  {p.on_sale && <div className="small"><span className="badge active">{p.promo_label || t('promo.onSale')}</span> <s className="muted">{formatCurrency(p.regular_price)}</s></div>}
                  {canPrice && !p.archived_at && <div><button type="button" className="link-btn small" onClick={() => setPromoFor(p)}>🏷️ {p.on_sale ? t('promo.edit') : t('promo.button')}</button></div>}
                </td>
                <td>{p.backroom_qty}{canShelf && Number(p.backroom_qty) > 0 && !p.archived_at && (
                  <div><button type="button" className="btn small" style={{ marginTop: 4 }} onClick={() => toShelf([p.id])}>➜ {t('products.toShelf')}</button></div>
                )}</td>
                <td>{p.shelf_qty}</td>
                {!simple && <td>{formatCurrency(p.stock_value)}</td>}
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
      {promoFor && <PromoDialog storeId={user.storeId} product={promoFor} onDone={load} onClose={() => setPromoFor(null)} />}
      <Toast {...(toast || {})} />
    </div>
  );
}

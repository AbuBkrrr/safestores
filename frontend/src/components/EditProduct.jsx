import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Modal, Alert } from './ui.jsx';
import { lookOfFile, packLook } from '../utils/visualMatch.js';

/**
 * Change a product that is already on sale: name, selling price, buying
 * price, category, barcode/QR, photo, low-stock level. Saved for the till,
 * the online shop and the marketplace at once (admin / manager).
 */
export default function EditProduct({ storeId, product, categories = [], onSaved, onClose }) {
  const { t } = useTranslation();
  const sell = Number(product.regular_price ?? product.selling_price ?? Number(product.cost_price) * Number(product.price_multiplier)) || 0;
  const [f, setF] = useState({
    name: product.name || '', price: sell ? String(Math.round(sell * 100) / 100) : '', cost: Number(product.cost_price) > 0 ? String(Number(product.cost_price)) : '',
    category: product.category || '', barcode: product.barcode || '', reorder: product.reorder_level ?? '',
  });
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const markup = Number(f.cost) > 0 && Number(f.price) > 0 ? Math.round(((Number(f.price) / Number(f.cost)) - 1) * 1000) / 10 : null;

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const price = Number(f.price); const cost = Number(f.cost);
    if (!f.name.trim()) return setError(t('quickAdd.needName'));
    if (!(price > 0)) return setError(t('quickAdd.needPrice'));
    // Prices are kept as cost x markup: with no buying price, the price itself is the cost (profit 0 until a cost is entered).
    const costPrice = cost > 0 ? cost : price;
    setBusy(true);
    try {
      const body = { name: f.name.trim(), category: f.category.trim() || null, barcode: f.barcode.trim() || null, costPrice, priceMultiplier: price / costPrice };
      if (f.reorder !== '' && Number(f.reorder) >= 0) body.reorderLevel = Math.floor(Number(f.reorder));
      const { data } = await api.put(`/stores/${storeId}/products/${product.id}`, body);
      let saved = data;
      if (photo) {
        const fd = new FormData(); fd.append('photo', photo);
        saved = (await api.post(`/stores/${storeId}/products/${product.id}/photo`, fd)).data || saved;
        const look = await lookOfFile(photo).catch(() => null);
        if (look) api.post(`/stores/${storeId}/products/${product.id}/looks`, { sig: packLook(look) }).catch(() => {});
      }
      onSaved?.(saved);
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`✏️ ${t('editProduct.title', { name: product.name })}`} onClose={onClose}>
      <form onSubmit={save}>
        <Alert type="error">{error}</Alert>
        <div className="grid grid-2">
          <div className="form-group"><label htmlFor="ep-name">{t('quickAdd.name')}</label><input id="ep-name" value={f.name} onChange={set('name')} autoFocus /></div>
          <div className="form-group">
            <label htmlFor="ep-price">{t('quickAdd.price')}</label>
            <input id="ep-price" type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={set('price')} />
            {markup !== null && <span className="help-text">{t('quickAdd.profit', { pct: markup })}</span>}
          </div>
          <div className="form-group"><label htmlFor="ep-cost">{t('quickAdd.cost')}</label><input id="ep-cost" type="number" inputMode="decimal" min="0" step="0.01" value={f.cost} onChange={set('cost')} /></div>
          <div className="form-group">
            <label htmlFor="ep-cat">{t('quickAdd.category')}</label>
            <input id="ep-cat" list="ep-cats" value={f.category} onChange={set('category')} autoComplete="off" />
            <datalist id="ep-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="form-group"><label htmlFor="ep-bar">{t('quickAdd.barcode')}</label><input id="ep-bar" value={f.barcode} onChange={set('barcode')} autoComplete="off" /></div>
          <div className="form-group"><label htmlFor="ep-reorder">{t('editProduct.lowStockAt')}</label><input id="ep-reorder" type="number" inputMode="numeric" min="0" step="1" value={f.reorder} onChange={set('reorder')} /></div>
          <div className="form-group">
            <label htmlFor="ep-photo">📷 {product.image_url ? t('products.changePhoto') : t('products.addPhoto')}</label>
            <input id="ep-photo" type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
          </div>
        </div>
        <p className="help-text">{t('editProduct.stockNote')}</p>
        <div className="flex" style={{ gap: 8 }}>
          <button className="btn" disabled={busy}>{busy ? t('quickAdd.saving') : t('editProduct.save')}</button>
          <button type="button" className="btn secondary" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Modal>
  );
}

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert } from './ui.jsx';
import { lookOfFile, packLook } from '../utils/visualMatch.js';

/**
 * The fast way to add a product: photo, name, what it cost, what it sells
 * for, how many — and it is on the shelf and sellable at once. Everything
 * else (SKU, unit, reorder level…) gets a sensible default and can be edited
 * later. "Save & next" keeps the category so a whole delivery goes in quickly.
 */
export default function QuickAddProduct({ storeId, categories = [], defaultUnit = 'piece', onAdded, onClose }) {
  const { t } = useTranslation();
  const empty = { name: '', cost: '', price: '', qty: '', category: '', barcode: '', onShelf: true };
  const [f, setF] = useState(empty);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const nameRef = useRef();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const markup = Number(f.cost) > 0 && Number(f.price) > 0 ? Math.round(((Number(f.price) / Number(f.cost)) - 1) * 1000) / 10 : null;

  const save = async (e, next) => {
    e?.preventDefault();
    setError(''); setDone('');
    const cost = Number(f.cost); const price = Number(f.price); const qty = Math.max(0, Number(f.qty) || 0);
    if (!f.name.trim()) return setError(t('quickAdd.needName'));
    if (!(price > 0)) return setError(t('quickAdd.needPrice'));
    // No buying price known: use the selling price (profit shows as 0 until a real cost is entered).
    const costPrice = cost > 0 ? cost : price;
    setBusy(true);
    try {
      const sku = (f.barcode || `${f.name.trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'ITEM'}-${Date.now().toString(36).slice(-5).toUpperCase()}`);
      const { data: p } = await api.post(`/stores/${storeId}/products`, {
        name: f.name.trim(), sku, category: f.category.trim() || null, unit: defaultUnit, soldBy: 'unit',
        costPrice, priceMultiplier: price / costPrice, initialBackroomQty: qty, putOnShelf: f.onShelf ? qty : 0,
        barcode: f.barcode || undefined,
      });
      if (photo) {
        const fd = new FormData(); fd.append('photo', photo);
        await api.post(`/stores/${storeId}/products/${p.id}/photo`, fd).catch(() => {});
        const look = await lookOfFile(photo);
        if (look) api.post(`/stores/${storeId}/products/${p.id}/looks`, { sig: packLook(look) }).catch(() => {});
      }
      setDone(t('quickAdd.added', { name: p.name }));
      onAdded?.(p);
      setF({ ...empty, category: f.category });
      setPhoto(null);
      if (next) setTimeout(() => nameRef.current?.focus(), 50); else onClose?.();
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={(e) => save(e, true)}>
      <h3>⚡ {t('quickAdd.title')}</h3>
      <p className="help-text">{t('quickAdd.help')}</p>
      <Alert type="error">{error}</Alert>
      <Alert type="success">{done}</Alert>
      <div className="grid grid-2">
        <div className="form-group"><label htmlFor="qa-name">{t('quickAdd.name')}</label><input id="qa-name" ref={nameRef} value={f.name} onChange={set('name')} autoFocus autoComplete="off" /></div>
        <div className="form-group">
          <label htmlFor="qa-photo">{t('quickAdd.photo')}</label>
          <input id="qa-photo" type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
        </div>
        <div className="form-group"><label htmlFor="qa-cost">{t('quickAdd.cost')}</label><input id="qa-cost" type="number" inputMode="decimal" min="0" step="0.01" value={f.cost} onChange={set('cost')} /></div>
        <div className="form-group">
          <label htmlFor="qa-price">{t('quickAdd.price')}</label>
          <input id="qa-price" type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={set('price')} />
          {markup !== null && <span className="help-text">{t('quickAdd.profit', { pct: markup })}</span>}
        </div>
        <div className="form-group"><label htmlFor="qa-qty">{t('quickAdd.qty')}</label><input id="qa-qty" type="number" inputMode="numeric" min="0" step="1" value={f.qty} onChange={set('qty')} /></div>
        <div className="form-group">
          <label htmlFor="qa-cat">{t('quickAdd.category')}</label>
          <input id="qa-cat" list="qa-cats" value={f.category} onChange={set('category')} autoComplete="off" />
          <datalist id="qa-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="form-group"><label htmlFor="qa-bar">{t('quickAdd.barcode')}</label><input id="qa-bar" value={f.barcode} onChange={set('barcode')} inputMode="numeric" autoComplete="off" /></div>
        <label className="flex" style={{ alignItems: 'center', gap: 8 }}><input type="checkbox" checked={f.onShelf} onChange={set('onShelf')} /> {t('quickAdd.onShelf')}</label>
      </div>
      <div className="flex mt-1" style={{ gap: 8 }}>
        <button className="btn" disabled={busy}>{busy ? t('quickAdd.saving') : t('quickAdd.saveNext')}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={(e) => save(e, false)}>{t('quickAdd.saveClose')}</button>
        {onClose && <button type="button" className="btn secondary" onClick={onClose}>{t('common.cancel')}</button>}
      </div>
    </form>
  );
}

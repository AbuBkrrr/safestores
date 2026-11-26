import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Modal, Alert } from './ui.jsx';

/** Put one product on sale: a sale price, until a date (optional), with a short label. */
export default function PromoDialog({ storeId, product, onDone, onClose }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ price: product.on_sale ? product.promo_price : '', until: product.promo_ends_at ? String(product.promo_ends_at).slice(0, 10) : '', label: product.promo_label || '' });
  const [error, setError] = useState('');
  const save = async (stop) => {
    setError('');
    try {
      await api.put(`/stores/${storeId}/products/${product.id}/promo`, stop ? { promoPrice: null }
        : { promoPrice: Number(f.price), promoEndsAt: f.until ? `${f.until}T23:59:59` : null, promoLabel: f.label });
      onDone?.(); onClose();
    } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
  };
  const regular = Number(product.regular_price ?? product.selling_price);
  const pct = Number(f.price) > 0 && regular > 0 ? Math.round(100 - (100 * Number(f.price)) / regular) : null;
  return (
    <Modal title={`🏷️ ${t('promo.title', { name: product.name })}`} onClose={onClose}>
      <Alert type="error">{error}</Alert>
      <p className="help-text">{t('promo.regular', { price: regular.toFixed(2) })}</p>
      <div className="form-group"><label htmlFor="pr-price">{t('promo.salePrice')}</label><input id="pr-price" type="number" inputMode="decimal" min="0" step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} autoFocus />
        {pct !== null && pct > 0 && <span className="help-text">{t('promo.off', { pct })}</span>}</div>
      <div className="form-group"><label htmlFor="pr-until">{t('promo.until')}</label><input id="pr-until" type="date" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></div>
      <div className="form-group"><label htmlFor="pr-label">{t('promo.label')}</label><input id="pr-label" value={f.label} maxLength={60} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={t('promo.labelPh')} /></div>
      <div className="flex" style={{ gap: 8 }}>
        <button type="button" className="btn" disabled={!(Number(f.price) > 0)} onClick={() => save(false)}>{t('promo.start')}</button>
        {product.on_sale && <button type="button" className="btn secondary" onClick={() => save(true)}>{t('promo.stop')}</button>}
      </div>
    </Modal>
  );
}

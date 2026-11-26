import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import client from '../api/client.js';
import { Modal, Alert } from './ui.jsx';
import { shopper } from '../utils/shopperLocal.js';

/** Ask a shop about an item, or request something it doesn't stock. Replies show in "Messages". */
export default function AskShopDialog({ store, product, kind = 'question', onClose }) {
  const { t } = useTranslation();
  const me = shopper.profile();
  const [f, setF] = useState({ name: me.name || '', phone: me.phone || '', message: product ? t('shopper.askDefault', { item: product.name }) : '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const send = async (e) => {
    e.preventDefault(); setError('');
    try {
      const { data } = await client.post(`/marketplace/${store.id}/inquiries`, { ...f, kind, productId: product?.id });
      shopper.saveProfile({ name: f.name, phone: f.phone });
      shopper.addMessage({ token: data.token, storeId: store.id, storeName: store.name, product: product?.name || null, kind, text: f.message, at: Date.now() });
      setDone(true);
    } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
  };
  const wa = String(store.phone || '').replace(/[^0-9]/g, '');
  return (
    <Modal title={kind === 'request' ? t('shopper.requestTitle', { store: store.name }) : t('shopper.askTitle', { store: store.name })} onClose={onClose}>
      {done ? (
        <>
          <Alert type="success">{t('shopper.sent')}</Alert>
          <button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>
        </>
      ) : (
        <form onSubmit={send}>
          <Alert type="error">{error}</Alert>
          {kind === 'request' && <p className="help-text">{t('shopper.requestHelp')}</p>}
          <div className="form-group"><label htmlFor="ask-msg">{t('shopper.message')}</label><textarea id="ask-msg" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required /></div>
          <div className="form-group"><label htmlFor="ask-name">{t('shopper.yourName')}</label><input id="ask-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="form-group"><label htmlFor="ask-phone">{t('shopper.yourPhone')}</label><input id="ask-phone" type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></div>
          <div className="flex" style={{ gap: 8 }}>
            <button className="btn">{t('shopper.send')}</button>
            {wa && <a className="btn secondary" href={`https://wa.me/${wa}?text=${encodeURIComponent(f.message)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
            {store.phone && <a className="btn secondary" href={`tel:${store.phone}`}>📞</a>}
          </div>
        </form>
      )}
    </Modal>
  );
}

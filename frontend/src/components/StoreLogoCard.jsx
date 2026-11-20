import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useStoreProfile, setCachedProfile } from '../utils/useStoreTier.js';
import { mediaUrl } from '../utils/media.js';

/** The store's logo: shown in the app's sidebar, on the online shop and on its pages. */
export default function StoreLogoCard({ onToast }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { logoUrl } = useStoreProfile();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    setBusy(true);
    try {
      const r = await api.post(`/stores/${user.storeId}/branding/logo`, fd);
      setCachedProfile(user.storeId, { logoUrl: r.data.url });
      onToast?.(t('storeLogo.saved'), 'success');
    } catch (err) { onToast?.(err.response?.data?.error || t('storeLogo.failed'), 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.patch(`/stores/${user.storeId}/marketplace-profile`, { logoUrl: null });
      setCachedProfile(user.storeId, { logoUrl: null });
    } catch (err) { onToast?.(err.response?.data?.error || t('storeLogo.failed'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h3>🖼️ {t('storeLogo.title')}</h3>
      <p className="muted">{t('storeLogo.sub')}</p>
      <div className="flex mt-1" style={{ alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {logoUrl
          ? <img src={mediaUrl(logoUrl)} alt={t('storeLogo.title')} style={{ width: 72, height: 72, objectFit: 'contain', background: '#fff', borderRadius: 10, padding: 4 }} />
          : <div className="muted" style={{ width: 72, height: 72, borderRadius: 10, border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }} aria-hidden="true">🏪</div>}
        <input ref={input} type="file" accept="image/*" hidden onChange={upload} aria-label={t('storeLogo.upload')} />
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>{logoUrl ? t('storeLogo.change') : t('storeLogo.upload')}</button>
        {logoUrl && <button type="button" className="btn secondary" disabled={busy} onClick={remove}>{t('storeLogo.remove')}</button>}
      </div>
      <p className="help-text mt-1">{t('storeLogo.help')}</p>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert } from './ui.jsx';
import { SHOP_FONTS, shopThemeVars } from '../utils/shopTheme.js';

const PRESETS = [
  { name: 'Teal', brandColor: '#0f7180', bgColor: '' },
  { name: 'Market red', brandColor: '#c0392b', bgColor: '#fff5f2' },
  { name: 'Fresh green', brandColor: '#1f8a4c', bgColor: '#f1faf3' },
  { name: 'Royal', brandColor: '#4b3bbd', bgColor: '#f4f2ff' },
  { name: 'Gold', brandColor: '#b7791f', bgColor: '#fffaf0' },
  { name: 'Night', brandColor: '#f0b429', bgColor: '#0f141a', theme: 'dark' },
];

// Store side: logo, colours, font and background for the online shop.
export default function BrandingPanel({ onToast, shopUrl }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canEdit = ['admin', 'manager'].includes(user.role);
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const fromStore = (p) => ({
    logoUrl: p.shop_logo_url || '', bgImageUrl: p.shop_bg_image_url || '', brandColor: p.shop_brand_color || '',
    bgColor: p.shop_bg_color || '', font: p.shop_font || '', theme: p.shop_theme || '', name: p.name,
  });
  useEffect(() => {
    api.get(`/stores/${user.storeId}/marketplace-profile`).then((r) => setB(fromStore(r.data))).catch(() => {});
  }, [user.storeId]);
  useEffect(() => {
    if (!b?.font) return undefined;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(b.font)}:wght@400;700&display=swap`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [b?.font]);
  if (!b) return null;
  const set = (k) => (e) => setB({ ...b, [k]: e.target.value });

  const upload = async (kind, file) => {
    if (!file) return;
    setError(''); setBusy(kind);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const { data } = await api.post(`/stores/${user.storeId}/branding/${kind}`, fd);
      setB((cur) => ({ ...cur, [kind === 'logo' ? 'logoUrl' : 'bgImageUrl']: data.url }));
      onToast?.(t('branding.uploaded'), 'success');
    } catch (err) { setError(err.response?.data?.error || t('branding.failed')); } finally { setBusy(''); }
  };
  const save = async (e) => {
    e.preventDefault();
    setError(''); setBusy('save');
    try {
      const { data } = await api.patch(`/stores/${user.storeId}/marketplace-profile`, {
        brandColor: b.brandColor, bgColor: b.bgColor, font: b.font, theme: b.theme,
        ...(b.logoUrl ? {} : { logoUrl: '' }), ...(b.bgImageUrl ? {} : { bgImageUrl: '' }),
      });
      setB(fromStore(data));
      onToast?.(t('branding.saved'), 'success');
    } catch (err) { setError(err.response?.data?.error || t('branding.failed')); } finally { setBusy(''); }
  };

  const preview = {
    shop_brand_color: b.brandColor, shop_font: b.font, shop_theme: b.theme,
  };
  const previewBg = {
    backgroundColor: b.bgColor || 'var(--bg)',
    ...(b.bgImageUrl ? { backgroundImage: `url("${b.bgImageUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
  };

  return (
    <div className="card">
      <h3>🎨 {t('branding.title')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('branding.intro')}</p>
      <Alert type="error">{error}</Alert>
      <form onSubmit={save}>
        <div className="grid grid-2">
          <div className="form-group">
            <label htmlFor="br-logo">{t('branding.logo')}</label>
            <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {b.logoUrl && <img src={b.logoUrl} alt="" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 10, border: '1px solid var(--line)', background: '#fff' }} />}
              <input id="br-logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" disabled={!canEdit || busy === 'logo'} onChange={(e) => upload('logo', e.target.files[0])} />
              {b.logoUrl && canEdit && <button type="button" className="btn small secondary" onClick={() => setB({ ...b, logoUrl: '' })}>{t('branding.remove')}</button>}
            </div>
            <span className="help-text">{t('branding.logoHelp')}</span>
          </div>
          <div className="form-group">
            <label htmlFor="br-bgimg">{t('branding.bgImage')}</label>
            <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {b.bgImageUrl && <img src={b.bgImageUrl} alt="" style={{ width: 72, height: 48, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />}
              <input id="br-bgimg" type="file" accept="image/png,image/jpeg,image/webp" disabled={!canEdit || busy === 'background'} onChange={(e) => upload('background', e.target.files[0])} />
              {b.bgImageUrl && canEdit && <button type="button" className="btn small secondary" onClick={() => setB({ ...b, bgImageUrl: '' })}>{t('branding.remove')}</button>}
            </div>
            <span className="help-text">{t('branding.bgImageHelp')}</span>
          </div>
          <div className="form-group">
            <label htmlFor="br-color">{t('branding.brandColor')}</label>
            <div className="brand-swatch">
              <input id="br-color" type="color" value={b.brandColor || '#0f7180'} onChange={set('brandColor')} disabled={!canEdit} />
              <code>{b.brandColor || t('branding.default')}</code>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="br-bg">{t('branding.bgColor')}</label>
            <div className="brand-swatch">
              <input id="br-bg" type="color" value={b.bgColor || '#f5f7f8'} onChange={set('bgColor')} disabled={!canEdit} />
              <code>{b.bgColor || t('branding.default')}</code>
              {b.bgColor && canEdit && <button type="button" className="btn small secondary" onClick={() => setB({ ...b, bgColor: '' })}>{t('branding.reset')}</button>}
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="br-font">{t('branding.font')}</label>
            <select id="br-font" value={b.font} onChange={set('font')} disabled={!canEdit}>
              <option value="">{t('branding.defaultFont')}</option>
              {SHOP_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="br-theme">{t('branding.cards')}</label>
            <select id="br-theme" value={b.theme} onChange={set('theme')} disabled={!canEdit}>
              <option value="">{t('branding.themeAuto')}</option>
              <option value="light">{t('branding.themeLight')}</option>
              <option value="dark">{t('branding.themeDark')}</option>
            </select>
          </div>
        </div>

        {canEdit && (
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>{t('branding.presets')}:</span>
            {PRESETS.map((p) => (
              <button key={p.name} type="button" className="btn small secondary" style={{ borderColor: p.brandColor, color: p.brandColor }}
                onClick={() => setB({ ...b, brandColor: p.brandColor, bgColor: p.bgColor, theme: p.theme || '' })}>{p.name}</button>
            ))}
          </div>
        )}

        <div className="form-group">
          <label>{t('branding.preview')}</label>
          <div style={{ ...previewBg, borderRadius: 'var(--radius)', padding: 16 }}>
            <div className="storefront" data-sf-theme={b.theme || undefined} style={{ ...shopThemeVars(preview), padding: 0 }}>
              <div className="brand-preview" style={{ background: 'var(--panel)', color: 'var(--text)' }}>
                {b.logoUrl
                  ? <img className="sf-avatar sf-logo" src={b.logoUrl} alt="" />
                  : <div className="sf-avatar">{(b.name || 'S').charAt(0).toUpperCase()}</div>}
                <div style={{ flex: 1 }}>
                  <strong style={{ fontSize: 20 }}>{b.name}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>{t('branding.sampleProduct')} · <strong style={{ color: 'var(--text)' }}>₦1,200</strong></div>
                </div>
                <span className="btn small" style={{ pointerEvents: 'none' }}>{t('branding.sampleButton')}</span>
              </div>
            </div>
          </div>
        </div>

        {canEdit && <button className="btn" type="submit" disabled={busy === 'save'}>{t('branding.save')}</button>}{' '}
        {shopUrl && <a className="btn secondary" href={shopUrl} target="_blank" rel="noreferrer">{t('branding.viewShop')}</a>}
      </form>
    </div>
  );
}

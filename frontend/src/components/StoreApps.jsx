import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';

// Links from the server are site-relative (/api/...); the Android app talks to
// the server by its full address, so make them absolute from the API base.
const absolute = (url) => {
  const base = String(api.defaults.baseURL || '/api').replace(/\/api\/?$/, '');
  return `${base}${url}`;
};

/**
 * A store's own Windows and Android apps: progress while they are being made,
 * then two download buttons. `token` = the secret link from sign-up; without
 * it, the signed-in store's own apps are shown.
 */
export function StoreAppsPanel({ token, storeId }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let stop = false;
    let timer;
    const load = async () => {
      try {
        const r = await api.get(token ? `/store-apps/${token}` : `/stores/${storeId}/apps`);
        if (stop) return;
        setInfo(r.data);
        if (['queued', 'building'].includes(r.data.status)) timer = setTimeout(load, 20000);
      } catch { if (!stop) timer = setTimeout(load, 30000); }
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [token, storeId]);

  if (!info) return <p className="muted">{t('common.loading')}</p>;
  if (info.status === 'ready') {
    return (
      <div>
        <p>{t('storeApps.readyText', { name: info.name })}</p>
        <div className="flex mt-1" style={{ flexWrap: 'wrap' }}>
          <a className="btn" href={absolute(info.downloads.windows.url)} download={info.downloads.windows.file}>⬇ {t('storeApps.windows')}</a>
          <a className="btn" href={absolute(info.downloads.android.url)} download={info.downloads.android.file}>⬇ {t('storeApps.android')}</a>
        </div>
        <p className="help-text mt-1">{t('storeApps.installHelp')}</p>
      </div>
    );
  }
  if (['queued', 'building'].includes(info.status)) {
    return (
      <div>
        <p>⏳ {t('storeApps.building', { name: info.name })}</p>
        <p className="help-text">{t('storeApps.buildingHelp')}</p>
      </div>
    );
  }
  return <p className="muted">{t('storeApps.later')}</p>;
}

/** The pop-up shown right after a store signs up. */
export function StoreAppsPopup({ token, onClose }) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="store-apps-title">
      <div className="modal-card" style={{ maxWidth: 520 }}>
        <h2 id="store-apps-title">🎉 {t('storeApps.popupTitle')}</h2>
        <StoreAppsPanel token={token} />
        <div className="modal-actions mt-1"><button className="btn secondary" onClick={onClose}>{t('storeApps.continue')}</button></div>
      </div>
    </div>
  );
}

/** Store Settings card. */
export default function StoreAppsCard({ storeId }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h3>📲 {t('storeApps.cardTitle')}</h3>
      <p className="muted">{t('storeApps.cardSub')}</p>
      <StoreAppsPanel storeId={storeId} />
    </div>
  );
}

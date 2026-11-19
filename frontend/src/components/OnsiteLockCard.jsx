import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert } from './ui.jsx';
import { getFix } from '../utils/geo.js';

// Owner's switch for "in-store only": shop-floor staff can only sell, receive
// or move stock from the shop's internet connection or, by phone GPS, from
// inside the shop. The owner and manager keep working from anywhere.
export default function OnsiteLockCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const base = `/stores/${user.storeId}/onsite`;
  const [s, setS] = useState(null);
  const [label, setLabel] = useState('');
  const [radius, setRadius] = useState(100);
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);

  const load = () => api.get(base).then((r) => { setS(r.data); setRadius(r.data.radiusM); }).catch(() => {});
  useEffect(() => { load(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, ok) => {
    setBusy(true); setMsg({});
    try { const r = await fn(); if (r?.data) { setS((cur) => ({ ...cur, ...r.data })); } if (ok) setMsg({ type: 'success', text: ok }); await load(); }
    catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('onsite.failed') }); }
    finally { setBusy(false); }
  };

  const useMyLocation = () => run(async () => {
    const fix = await getFix({ timeoutMs: 15000 });
    if (!fix) throw { response: { data: { error: t('onsite.locationRefused') } } };
    return api.patch(base, { location: { lat: fix.lat, lng: fix.lng } });
  }, t('onsite.locationSaved'));

  if (!s) return null;
  const ready = s.networks.length > 0 || !!s.location;

  return (
    <div className="card" id="onsite-lock">
      <h3>📍 {t('onsite.title')}</h3>
      <p className="muted">{t('onsite.intro')}</p>
      <Alert type={msg.type}>{msg.text}</Alert>

      <label className="flex" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={!!s.enabled} disabled={busy || (!s.enabled && !ready)}
          onChange={(e) => run(() => api.patch(base, { enabled: e.target.checked }), e.target.checked ? t('onsite.nowOn') : t('onsite.nowOff'))} />
        <strong>{s.enabled ? t('onsite.on') : t('onsite.off')}</strong>
      </label>
      {!ready && <p className="muted" style={{ fontSize: 13 }}>{t('onsite.setupFirst')}</p>}

      <h4 style={{ marginTop: 16 }}>1. {t('onsite.networksTitle')}</h4>
      <p className="muted" style={{ fontSize: 13 }}>{t('onsite.networksHelp')}</p>
      <p style={{ fontSize: 13 }}>{s.onShopNetwork ? `✅ ${t('onsite.onSavedNetwork')}` : `ℹ️ ${t('onsite.notOnSavedNetwork')}`}</p>
      {s.networks.length > 0 && (
        <table><tbody>{s.networks.map((n, i) => (
          <tr key={`${n.ip}-${i}`}>
            <td>{n.label}</td>
            <td className="muted" style={{ fontSize: 12 }}>{t('onsite.addedOn', { date: new Date(n.addedAt).toLocaleDateString() })}</td>
            <td style={{ textAlign: 'right' }}><button className="btn small secondary" disabled={busy} onClick={() => run(() => api.delete(`${base}/networks/${i}`), t('onsite.removed'))}>{t('onsite.remove')}</button></td>
          </tr>
        ))}</tbody></table>
      )}
      {!s.onShopNetwork && (
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <input aria-label={t('onsite.networkName')} placeholder={t('onsite.networkNamePlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 240 }} />
          <button className="btn small" disabled={busy} onClick={() => run(() => api.post(`${base}/networks`, { label }), t('onsite.networkSaved')).then(() => setLabel(''))}>{t('onsite.saveThisNetwork')}</button>
        </div>
      )}

      <h4 style={{ marginTop: 16 }}>2. {t('onsite.gpsTitle')}</h4>
      <p className="muted" style={{ fontSize: 13 }}>{t('onsite.gpsHelp')}</p>
      <p style={{ fontSize: 13 }}>{s.location
        ? <>✅ {t('onsite.locationIsSet')} <a href={`https://www.openstreetmap.org/?mlat=${s.location.lat}&mlon=${s.location.lng}#map=18/${s.location.lat}/${s.location.lng}`} target="_blank" rel="noreferrer">{t('onsite.viewOnMap')}</a></>
        : `ℹ️ ${t('onsite.locationNotSet')}`}</p>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn small" disabled={busy} onClick={useMyLocation}>{s.location ? t('onsite.updateLocation') : t('onsite.setLocation')}</button>
        {s.location && <button className="btn small secondary" disabled={busy} onClick={() => run(() => api.patch(base, { location: null }), t('onsite.locationCleared'))}>{t('onsite.clearLocation')}</button>}
        <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
          {t('onsite.radius')}
          <input type="number" min="30" max="2000" step="10" value={radius} onChange={(e) => setRadius(e.target.value)} style={{ width: 90 }} aria-label={t('onsite.radius')} />
          m
          <button className="btn small secondary" disabled={busy || Number(radius) === s.radiusM} onClick={() => run(() => api.patch(base, { radiusM: Number(radius) }), t('onsite.radiusSaved'))}>{t('onsite.save')}</button>
        </label>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>{t('onsite.whoIsExempt')}</p>
    </div>
  );
}

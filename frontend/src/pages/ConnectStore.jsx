import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, AuthBrand } from '../components/ui.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

const DEFAULT_SERVER = import.meta.env.VITE_CLOUD_URL || 'https://app.safestores.name.ng';

/**
 * First run of a shop-computer app: the owner or a manager signs in once with
 * their online account (internet needed this one time). The store's staff,
 * products and stock are downloaded; after that the app works offline.
 */
export default function ConnectStore({ onDone }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ email: '', password: '', otp: '', serverUrl: DEFAULT_SERVER });
  const [needOtp, setNeedOtp] = useState(false);
  const [stores, setStores] = useState(null);
  const [storeId, setStoreId] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const r = await api.post('/setup/connect', { ...form, otp: form.otp || undefined, storeId: storeId || undefined });
      onDone(r.data);
    } catch (err) {
      const d = err.response?.data || {};
      if (d.code === 'TOTP_REQUIRED') setNeedOtp(true);
      if (d.code === 'CHOOSE_STORE') { setStores(d.stores || []); setStoreId(d.stores?.[0]?.id || ''); }
      setError(d.error || t('connectStore.failed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 440 }}>
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('connectStore.title')}</h1>
        <p className="subtitle">{t('connectStore.sub')}</p>
        <Alert type="error">{error}</Alert>
        <form onSubmit={submit}>
          <div className="form-group"><label htmlFor="cs-email">{t('connectStore.email')}</label>
            <input id="cs-email" type="email" autoComplete="username" value={form.email} onChange={set('email')} required /></div>
          <div className="form-group"><label htmlFor="cs-pass">{t('connectStore.password')}</label>
            <PasswordInput id="cs-pass" autoComplete="current-password" value={form.password} onChange={set('password')} required /></div>
          {needOtp && <div className="form-group"><label htmlFor="cs-otp">{t('connectStore.otp')}</label>
            <input id="cs-otp" inputMode="numeric" value={form.otp} onChange={set('otp')} /></div>}
          {stores && <div className="form-group"><label htmlFor="cs-store">{t('connectStore.whichStore')}</label>
            <select id="cs-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
          {advanced
            ? <div className="form-group"><label htmlFor="cs-server">{t('connectStore.server')}</label>
                <input id="cs-server" value={form.serverUrl} onChange={set('serverUrl')} /></div>
            : <p><button type="button" className="link-btn" onClick={() => setAdvanced(true)}>{t('connectStore.changeServer')}</button></p>}
          <button className="btn" style={{ width: '100%' }} disabled={busy}>{busy ? t('connectStore.connecting') : t('connectStore.connect')}</button>
        </form>
        <p className="help-text mt-1">{t('connectStore.help')}</p>
      </div>
    </div>
  );
}

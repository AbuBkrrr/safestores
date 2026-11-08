import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const IS_DESKTOP = import.meta.env.VITE_EDITION === 'desktop';

function saveToken(token) {
  if (token) localStorage.setItem('ss_token', token);
}

export default function Account() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [tfa, setTfa] = useState(null); // { secret, otpauthUrl, qr }
  const [tfaCode, setTfaCode] = useState('');
  const [disable, setDisable] = useState({ password: '', code: '' });
  const [deletion, setDeletion] = useState(null);
  const [closeForm, setCloseForm] = useState({ password: '', confirmName: '' });
  const isStoreAdmin = user.role === 'admin';

  const load = () => api.get('/account/me').then((r) => setMe(r.data)).catch(() => {});
  useEffect(() => {
    load();
    if (isStoreAdmin && !IS_DESKTOP) api.get(`/stores/${user.storeId}/deletion`).then((r) => setDeletion(r.data)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, okMsg) => {
    setError('');
    try {
      const r = await fn();
      if (okMsg !== false) showToast(r?.data?.message || okMsg || t('common.save'), 'success');
      return r;
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
      return null;
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/account/password', { currentPassword: pw.current, newPassword: pw.next }));
    if (r) { saveToken(r.data.token); setPw({ current: '', next: '' }); }
  };

  const startTfa = async () => {
    const r = await run(() => api.post('/account/2fa/setup'), false);
    if (r) setTfa({ ...r.data, qr: await QRCode.toDataURL(r.data.otpauthUrl, { margin: 1, width: 200 }) });
  };
  const confirmTfa = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/account/2fa/enable', { code: tfaCode }));
    if (r) { setTfa(null); setTfaCode(''); load(); }
  };
  const turnOffTfa = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/account/2fa/disable', disable));
    if (r) { setDisable({ password: '', code: '' }); load(); }
  };

  const logoutAll = async () => {
    const r = await run(() => api.post('/account/logout-all'));
    if (r) saveToken(r.data.token);
  };

  const downloadData = async () => {
    const r = await run(() => api.get('/account/export'), false);
    if (!r) return;
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `my-safestores-data-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  const deleteAccount = async () => {
    if (!confirm(t('accountPage.deleteConfirm'))) return;
    const password = me?.hasPassword ? prompt(t('accountPage.passwordLabel')) : '';
    if (me?.hasPassword && !password) return;
    const r = await run(() => api.delete('/account', { data: { password } }));
    if (r) { logout(); navigate('/login'); }
  };

  const scheduleClose = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(`/stores/${user.storeId}/deletion`, closeForm));
    if (r) { setDeletion({ deletion_scheduled_for: r.data.deletionScheduledFor }); setCloseForm({ password: '', confirmName: '' }); }
  };
  const cancelClose = async () => {
    const r = await run(() => api.delete(`/stores/${user.storeId}/deletion`));
    if (r) setDeletion({});
  };

  const resend = () => run(() => api.post('/account/email/resend'));

  return (
    <div>
      <div className="topbar"><h1>{t('accountPage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('accountPage.profile')}</h3>
          <p><strong>{me?.name || user.name}</strong><br /><span className="muted">{me?.email}</span></p>
          {me && !me.emailVerified && !IS_DESKTOP && (
            <Alert type="warning">{t('accountPage.emailNotVerified')} <button className="btn small secondary" onClick={resend}>{t('accountPage.resend')}</button></Alert>
          )}
          {me?.hasPassword && (
            <form onSubmit={changePassword} className="mt-1">
              <h4>{t('accountPage.changePassword')}</h4>
              <div className="form-group">
                <label htmlFor="acct-cur">{t('accountPage.currentPassword')}</label>
                <input id="acct-cur" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
              </div>
              <div className="form-group">
                <label htmlFor="acct-new">{t('accountPage.newPassword')}</label>
                <input id="acct-new" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
                <span className="help-text">{t('passwordHint')}</span>
              </div>
              <button className="btn">{t('accountPage.updatePassword')}</button>
            </form>
          )}
        </div>

        <div className="card">
          <h3>🔐 {t('accountPage.twoFactor')}</h3>
          {IS_DESKTOP ? <p className="muted">{t('accountPage.notAvailableDesktop')}</p> : (
            <>
              <p className="muted">{t('accountPage.twoFactorIntro')}</p>
              {me?.twoFactorEnabled ? (
                <form onSubmit={turnOffTfa}>
                  <Alert type="success">{t('accountPage.twoFactorOn')}</Alert>
                  <div className="form-group"><label htmlFor="tfa-off-pw">{t('accountPage.passwordLabel')}</label>
                    <input id="tfa-off-pw" type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} required /></div>
                  <div className="form-group"><label htmlFor="tfa-off-code">{t('accountPage.codeLabel')}</label>
                    <input id="tfa-off-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value.replace(/\D/g, '') })} required /></div>
                  <button className="btn danger">{t('accountPage.turnOff')}</button>
                </form>
              ) : tfa ? (
                <form onSubmit={confirmTfa}>
                  <p>{t('accountPage.scanQr')}</p>
                  <img src={tfa.qr} alt="QR code for your authenticator app" width={200} height={200} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
                  <p className="muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{tfa.secret}</p>
                  <div className="form-group"><label htmlFor="tfa-code">{t('accountPage.enterCode')}</label>
                    <input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={tfaCode} onChange={(e) => setTfaCode(e.target.value.replace(/\D/g, ''))} required /></div>
                  <button className="btn">{t('accountPage.confirmCode')}</button>
                </form>
              ) : (
                <>
                  <p>{t('accountPage.twoFactorOff')}</p>
                  {me?.hasPassword && <button className="btn" onClick={startTfa}>{t('accountPage.turnOn')}</button>}
                </>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h3>📱 {t('accountPage.sessions')}</h3>
          <p className="muted">{t('accountPage.sessionsIntro')}</p>
          <button className="btn secondary" onClick={logoutAll}>{t('accountPage.logoutAll')}</button>
        </div>

        <div className="card">
          <h3>📦 {t('accountPage.yourData')}</h3>
          <p className="muted">{t('accountPage.yourDataIntro')}</p>
          <button className="btn secondary" onClick={downloadData}>{t('accountPage.download')}</button>
          {!IS_DESKTOP && user.role !== 'super_admin' && (
            <>
              <h4 className="mt-1">{t('accountPage.deleteAccount')}</h4>
              <p className="muted">{t('accountPage.deleteAccountIntro')}</p>
              <button className="btn danger small" onClick={deleteAccount}>{t('accountPage.deleteAccount')}</button>
            </>
          )}
        </div>

        {isStoreAdmin && !IS_DESKTOP && deletion && (
          <div className="card" style={{ borderColor: '#b33a3a' }}>
            <h3>⚠️ {t('accountPage.closeStore')}</h3>
            {deletion.deletion_scheduled_for ? (
              <>
                <Alert type="warning">{t('accountPage.scheduledFor', { date: new Date(deletion.deletion_scheduled_for).toLocaleDateString() })}</Alert>
                <button className="btn" onClick={cancelClose}>{t('accountPage.cancelDeletion')}</button>
              </>
            ) : (
              <form onSubmit={scheduleClose}>
                <p className="muted">{t('accountPage.closeStoreIntro')}</p>
                <div className="form-group"><label htmlFor="close-name">{t('accountPage.typeStoreName')}{user.storeName ? ` ("${user.storeName}")` : ''}</label>
                  <input id="close-name" value={closeForm.confirmName} onChange={(e) => setCloseForm({ ...closeForm, confirmName: e.target.value })} required /></div>
                <div className="form-group"><label htmlFor="close-pw">{t('accountPage.passwordLabel')}</label>
                  <input id="close-pw" type="password" value={closeForm.password} onChange={(e) => setCloseForm({ ...closeForm, password: e.target.value })} required /></div>
                <button className="btn danger">{t('accountPage.requestDeletion')}</button>
              </form>
            )}
          </div>
        )}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

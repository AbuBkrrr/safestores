import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, AuthBrand, BrandFooter } from '../components/ui.jsx';

export default function ResetPassword() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(token ? '' : t('resetPage.missingToken'));
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError(t('resetPage.mismatch')); return; }
    setError(''); setLoading(true);
    try {
      await api.post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setLoading(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('resetPage.title')}</h1>
        <Alert type="error">{error}</Alert>
        {done ? (
          <>
            <Alert type="success">{t('resetPage.done')}</Alert>
            <Link className="btn" to="/login" style={{ width: '100%', textAlign: 'center' }}>{t('resetPage.goToLogin')}</Link>
          </>
        ) : token && (
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="reset-pw">{t('resetPage.newPassword')}</label>
              <input id="reset-pw" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <span className="help-text">{t('passwordHint')}</span>
            </div>
            <div className="form-group">
              <label htmlFor="reset-pw2">{t('resetPage.confirmPassword')}</label>
              <input id="reset-pw2" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            <button className="btn" style={{ width: '100%' }} disabled={loading}>{t('resetPage.save')}</button>
          </form>
        )}
        <div className="auth-links"><Link to="/login">← {t('forgotPage.backToLogin')}</Link></div>
        <BrandFooter />
      </div>
    </div>
  );
}

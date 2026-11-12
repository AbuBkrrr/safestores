import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, AuthBrand, BrandFooter } from '../components/ui.jsx';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setMsg(''); setLoading(true);
    try {
      const { data } = await api.post('/auth/password/forgot', { email });
      setMsg(data.message);
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setLoading(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('forgotPage.title')}</h1>
        <p className="subtitle">{t('forgotPage.subtitle')}</p>
        <Alert type="error">{error}</Alert>
        <Alert type="success">{msg}</Alert>
        {!msg && (
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="forgot-email">{t('login.email')}</label>
              <input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="btn" style={{ width: '100%' }} disabled={loading}>{loading ? t('forgotPage.sending') : t('forgotPage.send')}</button>
          </form>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{t('forgotPage.noEmailHint')}</p>
        <div className="auth-links"><Link to="/login">← {t('forgotPage.backToLogin')}</Link></div>
        <BrandFooter />
      </div>
    </div>
  );
}

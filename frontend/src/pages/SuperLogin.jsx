import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, AuthBrand } from '../components/ui.jsx';

export default function SuperLogin() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [needOtp, setNeedOtp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { data } = await api.post('/auth/super-admin/login', { email, password, otp: needOtp ? otp : undefined });
      login(data.token, data.user);
      navigate('/super');
    } catch (err) {
      if (['TOTP_REQUIRED', 'TOTP_INVALID'].includes(err.response?.data?.code)) setNeedOtp(true);
      setError(err.response?.data?.error || t('superLoginPage.loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand tagline={t('superLoginPage.tagline')} />
        <h1>{t('superLoginPage.title')}</h1>
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('login.email')}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>{t('login.password')}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {needOtp && (
            <div className="form-group">
              <label htmlFor="super-otp">{t('login.twoFactorCode')}</label>
              <input id="super-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
              <span className="help-text">{t('login.twoFactorHelp')}</span>
            </div>
          )}
          <button className="btn gold" style={{ width: '100%' }} disabled={loading}>
            {loading ? t('login.signingIn') : t('superLoginPage.submit')}
          </button>
        </form>
        <div className="auth-links"><Link to="/login">{t('superLoginPage.backToStore')}</Link></div>
      </div>
    </div>
  );
}

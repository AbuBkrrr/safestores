import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, AuthBrand, BrandFooter } from '../components/ui.jsx';

export default function Login() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const inviteFromLink = searchParams.get('invite');

  const [tab, setTab] = useState(inviteFromLink ? 'invite' : 'admin'); // 'admin' | 'invite'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(inviteFromLink ? inviteFromLink.toUpperCase() : '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // If someone opens a shared invite link (?invite=CODE), switch to the
  // Invite tab and pre-fill the code automatically instead of leaving them
  // to copy-paste it manually.
  useEffect(() => {
    if (inviteFromLink) {
      setTab('invite');
      setCode(inviteFromLink.toUpperCase());
    }
  }, [inviteFromLink]);

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { data } = await api.post('/auth/admin/login', { email, password });
      login(data.token, data.user);
      // A pending store's admin gets sent to activation instead of the dashboard.
      navigate(data.user.subscriptionStatus && data.user.subscriptionStatus !== 'active' ? '/activate-store' : '/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleInviteLogin = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { data } = await api.post('/auth/invite/login', { code });
      login(data.token, data.user);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Invite login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('login.welcomeBack')}</h1>
        <p className="subtitle">{tab === 'admin' ? t('login.adminSubtitle') : t('login.inviteSubtitle')}</p>
        <div className="auth-tabs">
          <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>{t('login.adminLogin')}</button>
          <button className={tab === 'invite' ? 'active' : ''} onClick={() => setTab('invite')}>{t('login.inviteLogin')}</button>
        </div>

        <Alert type="error">{error}</Alert>

        {tab === 'admin' ? (
          <form onSubmit={handleAdminLogin}>
            <div className="form-group">
              <label htmlFor="login-email">{t('login.email')}</label>
              <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label htmlFor="login-password">{t('login.password')}</label>
              <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className="btn" style={{ width: '100%' }} disabled={loading}>
              {loading ? t('login.signingIn') : t('login.signIn')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleInviteLogin}>
            <div className="form-group">
              <label htmlFor="login-invite-code">{t('login.inviteCode')}</label>
              <input id="login-invite-code" placeholder="INV-XXXXXXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required />
              <span className="help-text">{t('login.inviteCodeHelp')}</span>
            </div>
            <button className="btn" style={{ width: '100%' }} disabled={loading}>
              {loading ? t('login.signingIn') : t('login.enterWithCode')}
            </button>
          </form>
        )}

        <div className="auth-links">
          {t('login.newStore')} <Link to="/signup">{t('login.registerStore')}</Link><br />
          <Link to="/super-login">{t('login.superAdminLogin')}</Link>
        </div>
      <BrandFooter />
      </div>
    </div>
  );
}

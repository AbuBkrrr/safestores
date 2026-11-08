import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, AuthBrand, BrandFooter } from '../components/ui.jsx';

export default function VerifyEmail() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { user, updateUser } = useAuth();
  const [state, setState] = useState({ loading: true, ok: '', error: '' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke would burn the one-time token
    ran.current = true;
    api.post('/auth/email/verify', { token: params.get('token') })
      .then((r) => { setState({ loading: false, ok: r.data.message, error: '' }); if (user) updateUser({ emailVerified: true }); })
      .catch((err) => setState({ loading: false, ok: '', error: err.response?.data?.error || t('common.errorGeneric') }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('verifyPage.title')}</h1>
        {state.loading && <p className="muted">{t('verifyPage.working')}</p>}
        <Alert type="success">{state.ok}</Alert>
        <Alert type="error">{state.error}</Alert>
        {!state.loading && <Link className="btn" to={user ? '/' : '/login'} style={{ width: '100%', textAlign: 'center' }}>{t('verifyPage.continue')}</Link>}
        <BrandFooter />
      </div>
    </div>
  );
}

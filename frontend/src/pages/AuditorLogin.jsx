import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, BrandFooter } from '../components/ui.jsx';

export default function AuditorLogin() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post('/auth/auditor/login', form);
      login(data.token, data.user);
      navigate('/auditor');
    } catch (err) {
      setError(err.response?.data?.error || t('auditorLoginPage.loginFailed'));
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 380 }}>
        <h1>{t('auditorLoginPage.title')}</h1>
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="form-group"><label>{t('auditorDashPage.email')}</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div className="form-group"><label>{t('login.password')}</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
          <button className="btn" style={{ width: '100%' }}>{t('auditorLoginPage.logIn')}</button>
        </form>
        <div className="auth-links">{t('auditorLoginPage.notAuditorYet')} <Link to="/auditor-signup">{t('auditorLoginPage.applyHere')}</Link></div>
      <BrandFooter />
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, BrandFooter } from '../components/ui.jsx';

export default function AuditorSignup() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();
  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await api.post('/auth/auditor/signup', form);
      setSuccess(t('auditorSignupPage.applicationReceived'));
      setTimeout(() => navigate('/auditor-login'), 3000);
    } catch (err) {
      setError(err.response?.data?.error || t('auditorSignupPage.signupFailed'));
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 420 }}>
        <h1>{t('auditorSignupPage.title')}</h1>
        <p className="muted">{t('auditorSignupPage.desc')}</p>
        <Alert type="error">{error}</Alert>
        <Alert type="success">{success}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="form-group"><label>{t('auditorSignupPage.fullName')}</label><input value={form.name} onChange={update('name')} required /></div>
          <div className="form-group"><label>{t('auditorDashPage.email')}</label><input type="email" value={form.email} onChange={update('email')} required /></div>
          <div className="form-group"><label>{t('login.password')}</label><input type="password" value={form.password} onChange={update('password')} required minLength={6} /></div>
          <button className="btn" style={{ width: '100%' }}>{t('auditorSignupPage.apply')}</button>
        </form>
        <div className="auth-links">{t('auditorSignupPage.alreadyAuditor')} <Link to="/auditor-login">{t('auditorLoginPage.logIn')}</Link></div>
      <BrandFooter />
      </div>
    </div>
  );
}

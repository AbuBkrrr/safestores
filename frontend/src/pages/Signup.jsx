import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, AuthBrand, BrandFooter } from '../components/ui.jsx';

export default function Signup() {
  const { t } = useTranslation();
  const TIERS = [
    { id: 'mini', label: t('signupPage.tierMiniLabel'), desc: t('signupPage.tierMiniDesc') },
    { id: 'midi', label: t('signupPage.tierMidiLabel'), desc: t('signupPage.tierMidiDesc') },
    { id: 'mega', label: t('signupPage.tierMegaLabel'), desc: t('signupPage.tierMegaDesc') },
  ];
  const [form, setForm] = useState({ storeName: '', adminName: '', adminEmail: '', password: '', storeTier: 'mini', referralContact: '' });
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (form.password !== confirmPassword) {
      setError(t('signupPage.passwordsMismatch'));
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/store/signup', form);
      setSuccess(t('signupPage.registrationSuccess'));
      setTimeout(() => navigate('/login'), 3500);
    } catch (err) {
      setError(err.response?.data?.error || t('signupPage.registrationFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 440 }}>
        <AuthBrand tagline={t('login.tagline')} />
        <h1>{t('signupPage.heading')}</h1>
        <p className="subtitle">{t('signupPage.subtitle')}</p>
        <Alert type="error">{error}</Alert>
        <Alert type="success">{success}</Alert>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('signupPage.storeName')}</label>
            <input value={form.storeName} onChange={update('storeName')} required />
          </div>
          <div className="form-group">
            <label>{t('signupPage.adminName')}</label>
            <input value={form.adminName} onChange={update('adminName')} required />
          </div>
          <div className="form-group">
            <label>{t('signupPage.adminEmail')}</label>
            <input type="email" value={form.adminEmail} onChange={update('adminEmail')} required />
          </div>
          <div className="form-group">
            <label>{t('login.password')}</label>
            <input type="password" value={form.password} onChange={update('password')} required minLength={6} placeholder={t('signupPage.minPasswordChars')} />
          </div>
          <div className="form-group">
            <label>{t('signupPage.confirmPasswordLabel')}</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={6} placeholder={t('signupPage.confirmPasswordPh')} />
          </div>
          <div className="form-group">
            <label>{t('signupPage.storeSize')}</label>
            <select value={form.storeTier} onChange={update('storeTier')}>
              {TIERS.map((tier) => <option key={tier.id} value={tier.id}>{tier.label}</option>)}
            </select>
            <div className="muted mt-1">{TIERS.find((tier) => tier.id === form.storeTier)?.desc}</div>
          </div>
          <div className="form-group">
            <label>{t('signupPage.referredBy')} <span className="muted">{t('signupPage.referredByOptional')}</span></label>
            <input value={form.referralContact} onChange={update('referralContact')} placeholder={t('signupPage.referralPlaceholder')} />
          </div>
          <p className="muted mt-1">
            {t('signupPage.postRegisterNote')}
          </p>
          <button className="btn" style={{ width: '100%' }} disabled={loading}>
            {loading ? t('signupPage.registering') : t('signupPage.registerStore')}
          </button>
        </form>

        <div className="auth-links">
          {t('signupPage.alreadyRegistered')} <Link to="/login">{t('auditorLoginPage.logIn')}</Link>
        </div>
      <BrandFooter />
      </div>
    </div>
  );
}

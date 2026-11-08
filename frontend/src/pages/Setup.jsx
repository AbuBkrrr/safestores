import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert } from '../components/ui.jsx';

export default function Setup({ onComplete }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) return setError(t('setupPage.passwordsMismatch'));
    setLoading(true);
    try {
      await api.post('/setup/super-admin', { name: form.name, email: form.email, password: form.password });
      onComplete?.();
      navigate('/super-login');
    } catch (err) {
      setError(err.response?.data?.error || t('setupPage.setupFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 440 }}>
        <h1>{t('setupPage.title')}</h1>
        <p className="muted mt-1" style={{ marginBottom: 18 }}>{t('setupPage.intro')}</p>
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="form-group"><label>{t('setupPage.yourName')}</label><input value={form.name} onChange={update('name')} required /></div>
          <div className="form-group"><label>{t('setupPage.email')}</label><input type="email" value={form.email} onChange={update('email')} required /></div>
          <div className="form-group"><label>{t('setupPage.password')}</label><input type="password" value={form.password} onChange={update('password')} required minLength={6} /></div>
          <div className="form-group"><label>{t('setupPage.confirmPassword')}</label><input type="password" value={form.confirm} onChange={update('confirm')} required /></div>
          <button className="btn" style={{ width: '100%' }} disabled={loading}>
            {loading ? t('setupPage.settingUp') : t('setupPage.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}

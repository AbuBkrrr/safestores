import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, BrandFooter } from '../components/ui.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

// Login for guarantors and couriers. With ?token=… it accepts a store's invite.
export default function PartnerLogin() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const invite = params.get('token');
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '' });
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (invite) api.get(`/partner/invite/${invite}`).then((r) => setInfo(r.data)).catch((e) => setError(e.response?.data?.error || t('partnerPage.failed')));
  }, [invite]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { data } = invite
        ? await api.post('/partner/accept', { token: invite, name: form.name, phone: form.phone, password: form.password })
        : await api.post('/auth/partner/login', { email: form.email, password: form.password });
      login(data.token, data.user);
      navigate('/partner');
    } catch (err) {
      setError(err.response?.data?.error || t('partnerPage.failed'));
    }
  };

  const creating = invite && info && !info.hasAccount;
  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 400 }}>
        <h1>{t('partnerPage.loginTitle')}</h1>
        {info && <p className="muted">{t(`partnerPage.invited_${info.kind}`, { store: info.storeName, guarantor: info.guarantorName || '' })}</p>}
        <Alert type="error">{error}</Alert>
        {(!invite || info) && (
          <form onSubmit={submit}>
            {invite
              ? <div className="form-group"><label>{t('partnerPage.email')}</label><input value={info.email} disabled /></div>
              : <div className="form-group"><label htmlFor="p-email">{t('partnerPage.email')}</label><input id="p-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>}
            {creating && <>
              <div className="form-group"><label htmlFor="p-name">{t('partnerPage.orgName')}</label><input id="p-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
              <div className="form-group"><label htmlFor="p-phone">{t('partnerPage.phone')}</label><input id="p-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" /></div>
            </>}
            <div className="form-group"><label>{creating ? t('partnerPage.choosePassword') : t('login.password')}</label>
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={creating ? 8 : undefined} required /></div>
            <button className="btn" style={{ width: '100%' }}>{invite ? (creating ? t('partnerPage.createAccept') : t('partnerPage.loginAccept')) : t('partnerPage.logIn')}</button>
          </form>
        )}
        <BrandFooter />
      </div>
    </div>
  );
}

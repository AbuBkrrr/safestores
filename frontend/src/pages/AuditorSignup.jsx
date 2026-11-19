import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { Alert, BrandFooter } from '../components/ui.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

export default function AuditorSignup() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', company: '', address: '', idType: 'NIN', idNumber: '', professionalBody: '', membershipNumber: '', yearsExperience: '' });
  const [files, setFiles] = useState({});
  const pickFile = (key) => (e) => setFiles({ ...files, [key]: e.target.files[0] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();
  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      Object.entries(files).forEach(([k, f]) => f && fd.append(k, f));
      await api.post('/auth/auditor/signup', fd);
      setSuccess(t('auditorSignupPage.applicationReceived'));
      setTimeout(() => navigate('/auditor-login'), 4000);
    } catch (err) {
      setError(err.response?.data?.error || t('auditorSignupPage.signupFailed'));
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 520, maxWidth: "100%" }}>
        <h1>{t('auditorSignupPage.title')}</h1>
        <p className="muted">{t('auditorSignupPage.desc')}</p>
        <Alert type="error">{error}</Alert>
        <Alert type="success">{success}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="form-group"><label>{t('auditorSignupPage.fullName')}</label><input value={form.name} onChange={update('name')} required /></div>
          <div className="form-group"><label>{t('auditorDashPage.email')}</label><input type="email" value={form.email} onChange={update('email')} required /></div>
          <div className="form-group"><label htmlFor="as-phone">{t('auditorSignupPage.phone')}</label><input id="as-phone" value={form.phone} onChange={update('phone')} inputMode="tel" required /></div>
          <div className="form-group"><label htmlFor="as-company">{t('auditorSignupPage.company')}</label><input id="as-company" value={form.company} onChange={update('company')} /></div>
          <div className="form-group"><label htmlFor="as-address">{t('auditorSignupPage.address')}</label><input id="as-address" value={form.address} onChange={update('address')} /></div>
          <div className="grid grid-2">
            <div className="form-group"><label htmlFor="as-idtype">{t('auditorSignupPage.idType')}</label>
              <select id="as-idtype" value={form.idType} onChange={update('idType')}>
                {['NIN', 'International passport', "Driver's licence", "Voter's card"].map((v) => <option key={v}>{v}</option>)}
              </select></div>
            <div className="form-group"><label htmlFor="as-idno">{t('auditorSignupPage.idNumber')}</label><input id="as-idno" value={form.idNumber} onChange={update('idNumber')} required /></div>
            <div className="form-group"><label htmlFor="as-body">{t('auditorSignupPage.professionalBody')}</label><input id="as-body" value={form.professionalBody} onChange={update('professionalBody')} placeholder="ICAN, ANAN, CIPM…" /></div>
            <div className="form-group"><label htmlFor="as-mno">{t('auditorSignupPage.membershipNumber')}</label><input id="as-mno" value={form.membershipNumber} onChange={update('membershipNumber')} /></div>
          </div>
          <div className="form-group"><label htmlFor="as-yrs">{t('auditorSignupPage.yearsExperience')}</label><input id="as-yrs" type="number" min="0" max="80" value={form.yearsExperience} onChange={update('yearsExperience')} /></div>
          <fieldset className="pay-choice">
            <legend>{t('auditorSignupPage.documents')}</legend>
            <p className="muted" style={{ fontSize: 12 }}>{t('auditorSignupPage.docsHelp')}</p>
            {[['idDocument', true], ['certificate', true], ['businessReg', false]].map(([k, req]) => (
              <div className="form-group" key={k}><label htmlFor={`as-${k}`}>{t(`auditorSignupPage.doc_${k}`)}{req ? ' *' : ''}</label>
                <input id={`as-${k}`} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={pickFile(k)} required={req} /></div>
            ))}
          </fieldset>
          <div className="form-group"><label>{t('login.password')}</label><PasswordInput value={form.password} onChange={update('password')} required minLength={8} /></div>
          <button className="btn" style={{ width: '100%' }}>{t('auditorSignupPage.apply')}</button>
        </form>
        <div className="auth-links">{t('auditorSignupPage.alreadyAuditor')} <Link to="/auditor-login">{t('auditorLoginPage.logIn')}</Link></div>
      <BrandFooter />
      </div>
    </div>
  );
}

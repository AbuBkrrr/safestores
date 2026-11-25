import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert } from '../components/ui.jsx';

export default function ActivateStore() {
  const { t } = useTranslation();
  const { user, updateUser, logout } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const isAdmin = user?.role === 'admin';
  // Asking support for a key, and a key support has already sent.
  const [act, setAct] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [ask, setAsk] = useState({ phone: '', message: '' });
  const [asking, setAsking] = useState(false);
  const loadAct = () => isAdmin && api.get(`/stores/${user.storeId}/activation`).then((r) => {
    setAct(r.data);
    if (r.data?.key?.code) setCode((c) => c || r.data.key.code);
  }).catch(() => {});
  useEffect(() => { loadAct(); const t2 = setInterval(loadAct, 30000); return () => clearInterval(t2); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sendRequest = async (e) => {
    e.preventDefault();
    setAsking(true); setError('');
    try {
      await api.post(`/stores/${user.storeId}/activation/request`, ask);
      setAskOpen(false);
      setSuccess(t('activatePage.requestSent'));
      loadAct();
    } catch (err) {
      setError(err.response?.data?.error || t('activatePage.requestFailed'));
    } finally { setAsking(false); }
  };
  const sup = act?.support || {};
  const wa = sup.whatsapp && String(sup.whatsapp).replace(/[^0-9]/g, '');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      await api.post(`/stores/${user.storeId}/redeem-code`, { code });
      setSuccess(t('activatePage.activatedSuccess'));
      updateUser({ subscriptionStatus: 'active' });
      setTimeout(() => navigate('/'), 1200);
    } catch (err) {
      setError(err.response?.data?.error || t('activatePage.activationFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 440 }}>
        <h1>{t('activatePage.title')}</h1>
        <p className="muted mt-1" style={{ marginBottom: 18 }}>
          {isAdmin
            ? t('activatePage.adminDesc', { storeName: user.storeName || t('activatePage.yourStoreFallback') })
            : t('activatePage.staffDesc')}
        </p>
        <Alert type="error">{error}</Alert>
        <Alert type="success">{success}</Alert>

        {isAdmin && (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>{t('activatePage.accessCode')}</label>
              <input placeholder="ACC-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required />
            </div>
            <button className="btn" style={{ width: '100%' }} disabled={loading}>
              {loading ? t('activatePage.activating') : t('activatePage.activateStore')}
            </button>
          </form>
        )}

        {isAdmin && act?.key && (
          <Alert type="success">{t('activatePage.keyArrived', { code: act.key.code, date: new Date(act.key.expires_at).toLocaleDateString() })}</Alert>
        )}

        {isAdmin && act && !act.key && (
          <div className="card mt-1" style={{ padding: 14 }}>
            <strong>{t('activatePage.noKeyTitle')}</strong>
            {act?.request ? (
              <p className="muted small mt-1">{t('activatePage.requestPending', { date: new Date(act.request.created_at).toLocaleString() })}</p>
            ) : askOpen ? (
              <form onSubmit={sendRequest} className="mt-1">
                <div className="form-group">
                  <label htmlFor="ask-phone">{t('activatePage.yourPhone')}</label>
                  <input id="ask-phone" type="tel" value={ask.phone} onChange={(e) => setAsk({ ...ask, phone: e.target.value })} placeholder="+234…" />
                </div>
                <div className="form-group">
                  <label htmlFor="ask-msg">{t('activatePage.messageOptional')}</label>
                  <textarea id="ask-msg" rows={2} value={ask.message} onChange={(e) => setAsk({ ...ask, message: e.target.value })} />
                </div>
                <button className="btn" style={{ width: '100%' }} disabled={asking}>{asking ? t('activatePage.sending') : t('activatePage.sendRequest')}</button>
              </form>
            ) : (
              <>
                <p className="muted small mt-1">{t('activatePage.noKeyDesc')}</p>
                <button type="button" className="btn secondary" style={{ width: '100%' }} onClick={() => setAskOpen(true)}>🔑 {t('activatePage.requestKey')}</button>
              </>
            )}
            {(sup.email || wa || sup.phone) && (
              <div className="flex mt-1" style={{ flexWrap: 'wrap', gap: 8 }}>
                {wa && <a className="btn secondary small" href={`https://wa.me/${wa}?text=${encodeURIComponent(t('activatePage.waText', { store: user.storeName || '' }))}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
                {sup.phone && <a className="btn secondary small" href={`tel:${sup.phone}`}>📞 {sup.phone}</a>}
                {sup.email && <a className="btn secondary small" href={`mailto:${sup.email}?subject=${encodeURIComponent(t('activatePage.waText', { store: user.storeName || '' }))}`}>✉️ {sup.email}</a>}
              </div>
            )}
          </div>
        )}

        <div className="auth-links">
          <a onClick={() => { logout(); navigate('/login'); }} style={{ cursor: 'pointer' }}>{t('activatePage.logOut')}</a>
        </div>
      </div>
    </div>
  );
}

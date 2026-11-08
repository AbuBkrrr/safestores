import { useState } from 'react';
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

        <div className="auth-links">
          <a onClick={() => { logout(); navigate('/login'); }} style={{ cursor: 'pointer' }}>{t('activatePage.logOut')}</a>
        </div>
      </div>
    </div>
  );
}

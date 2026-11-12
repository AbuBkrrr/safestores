import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const TYPE_KEY = { bank: 'typeBank', microfinance: 'typeMicrofinance', lending_app: 'typeLendingApp', other: 'typeOther' };

export default function LendingPartners() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/lending-partners`)
    .then((r) => setPartners(r.data))
    .catch(() => setError(t('lendingPage.loadFailed')))
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, [user.storeId]);

  const toggle = async (partner) => {
    const next = !partner.consented;
    // Optimistic update, same pattern as Super Admin's marketplace toggle.
    setPartners((prev) => prev.map((p) => (p.id === partner.id ? { ...p, consented: next } : p)));
    try {
      if (next) {
        await api.post(`/stores/${user.storeId}/lending-partners/${partner.id}/consent`);
        showToast(t('lendingPage.consentGranted', { name: partner.name }), 'success');
      } else {
        await api.delete(`/stores/${user.storeId}/lending-partners/${partner.id}/consent`);
        showToast(t('lendingPage.consentRevoked', { name: partner.name }), 'info');
      }
    } catch (err) {
      setPartners((prev) => prev.map((p) => (p.id === partner.id ? { ...p, consented: !next } : p)));
      showToast(err.response?.data?.error || t('lendingPage.actionFailed'), 'error');
    }
  };

  if (loading) return <div className="topbar"><h1>{t('lendingPage.title')}</h1></div>;

  return (
    <div>
      <div className="topbar"><h1>{t('lendingPage.title')}</h1></div>
      <p className="muted mt-1" style={{ marginBottom: 16 }}>{t('lendingPage.desc')}</p>
      <Alert type="error">{error}</Alert>

      <div className="card">
        {partners.length === 0 && <EmptyState>{t('lendingPage.noPartnersYet')}</EmptyState>}
        {partners.length > 0 && (
          <table>
            <thead>
              <tr><th>{t('lendingPage.partner')}</th><th>{t('lendingPage.type')}</th><th>{t('lendingPage.contact')}</th><th>{t('lendingPage.status')}</th><th></th></tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td>{t(`lendingPage.${TYPE_KEY[p.type] || 'typeOther'}`)}</td>
                  <td>{p.contact_email || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${p.consented ? 'active' : 'suspended'}`}>
                      {p.consented ? t('lendingPage.sharing') : t('lendingPage.notSharing')}
                    </span>
                  </td>
                  <td>
                    <button
                      className={`btn small ${p.consented ? 'danger' : ''}`}
                      onClick={() => toggle(p)}
                    >
                      {p.consented ? t('lendingPage.revokeConsent') : t('lendingPage.grantConsent')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

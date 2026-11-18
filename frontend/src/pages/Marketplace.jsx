import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const SYNC_EVENTS = ['marketplace:order_placed', 'marketplace:order_fulfilled', 'marketplace:order_cancelled', 'marketplace:order_paid'];

export default function Marketplace() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/marketplace/orders`).then((r) => setOrders(r.data));
  useEffect(() => { load(); }, [user.storeId]);

  // Shop profile: custom address (/shop/<slug>), tagline, category, location.
  const [profile, setProfile] = useState(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const toForm = (p) => ({ shopSlug: p.shop_slug || '', shopTagline: p.shop_tagline || '', category: p.category || '', city: p.city || '', address: p.address || '', enabled: p.marketplace_enabled });
  useEffect(() => {
    api.get(`/stores/${user.storeId}/marketplace-profile`).then((r) => setProfile(toForm(r.data))).catch(() => {});
  }, [user.storeId]);
  const saveProfile = async (e) => {
    e.preventDefault();
    setSavingProfile(true); setError('');
    try {
      const { enabled, ...body } = profile;
      const { data } = await api.patch(`/stores/${user.storeId}/marketplace-profile`, body);
      setProfile(toForm(data));
      showToast(t('marketplacePage.profileSaved'), 'success');
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.profileFailed'));
    } finally { setSavingProfile(false); }
  };
  const setP = (k) => (e) => setProfile({ ...profile, [k]: e.target.value });
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const fulfill = async (orderId) => {
    setError('');
    try {
      await api.patch(`/stores/${user.storeId}/marketplace/orders/${orderId}/fulfill`);
      showToast(t('marketplacePage.orderFulfilled'), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.fulfillFailed'));
    }
  };

  const cancel = async (o) => {
    const reason = window.prompt(t('marketplacePage.cancelPrompt'));
    if (reason === null) return;
    setError('');
    try {
      const { data } = await api.patch(`/stores/${user.storeId}/marketplace/orders/${o.id}/cancel`, { reason });
      showToast(data.refundDue ? t('marketplacePage.refundDueToast', { amount: data.amount }) : t('marketplacePage.orderCancelled'), data.refundDue ? 'warning' : 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.cancelFailed'));
    }
  };

  const markRefunded = async (o) => {
    if (!window.confirm(t('marketplacePage.confirmRefunded'))) return;
    try {
      await api.patch(`/stores/${user.storeId}/marketplace/orders/${o.id}/refunded`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.cancelFailed'));
    }
  };

  const storefrontUrl = `${window.location.origin}/shop/${profile?.shopSlug || user.storeId}`;

  return (
    <div>
      <div className="topbar"><h1>{t('marketplacePage.title')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="card">
        <p className="muted">{t('marketplacePage.storefrontLine')} <a href={storefrontUrl} target="_blank" rel="noreferrer">{storefrontUrl}</a>{' '}
          <button type="button" className="btn small secondary" onClick={() => navigator.clipboard?.writeText(storefrontUrl).then(() => showToast(t('marketplacePage.linkCopied'), 'success'))}>{t('marketplacePage.copyLink')}</button>
        </p>
        {profile && profile.enabled === false && <Alert type="warning">{t('marketplacePage.notListed')}</Alert>}
        {profile && (
          <form onSubmit={saveProfile} className="mt-1">
            <h3 style={{ marginBottom: 8 }}>{t('marketplacePage.shopProfile')}</h3>
            <div className="grid grid-2">
              <div className="form-group">
                <label htmlFor="mp-slug">{t('marketplacePage.shopAddress')}</label>
                <div className="flex" style={{ gap: 4, alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{window.location.host}/shop/</span>
                  <input id="mp-slug" value={profile.shopSlug} onChange={setP('shopSlug')} placeholder="mama-ngozi-lekki" maxLength={40} style={{ flex: 1 }} />
                </div>
                <span className="help-text">{t('marketplacePage.shopAddressHelp')}</span>
              </div>
              <div className="form-group">
                <label htmlFor="mp-tag">{t('marketplacePage.tagline')}</label>
                <input id="mp-tag" value={profile.shopTagline} onChange={setP('shopTagline')} maxLength={140} placeholder={t('marketplacePage.taglinePlaceholder')} />
              </div>
              <div className="form-group"><label htmlFor="mp-cat">{t('marketplacePage.category')}</label><input id="mp-cat" value={profile.category} onChange={setP('category')} /></div>
              <div className="form-group"><label htmlFor="mp-city">{t('marketplacePage.city')}</label><input id="mp-city" value={profile.city} onChange={setP('city')} /></div>
              <div className="form-group"><label htmlFor="mp-addr">{t('marketplacePage.address')}</label><input id="mp-addr" value={profile.address} onChange={setP('address')} /></div>
            </div>
            <button className="btn" type="submit" disabled={savingProfile}>{t('marketplacePage.saveProfile')}</button>
          </form>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('marketplacePage.orders')}</h3>
        <table>
          <thead><tr><th>{t('marketplacePage.customer')}</th><th>{t('marketplacePage.phone')}</th><th>{t('marketplacePage.total')}</th><th>{t('marketplacePage.deliveryAddress')}</th><th>{t('marketplacePage.status')}</th><th>{t('marketplacePage.placed')}</th><th></th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.customer_name}</td><td>{o.customer_phone || '—'}</td>
                <td>{formatCurrency(o.total)}</td>
                <td>{o.delivery_address || '—'}</td>
                <td><Badge status={o.status} /> {o.payment_status === 'refund_due' ? <span className="badge pending">{t('marketplacePage.refundDue')}</span> : o.payment_status === 'refunded' ? <span className="badge closed">{t('marketplacePage.refunded')}</span> : o.payment_status === 'paid' ? <span className="badge active">{t('marketplacePage.paidOnline')}</span> : o.payment_method === 'online' ? <span className="badge pending">{t('marketplacePage.awaitingPayment')}</span> : <span className="badge closed">{t('marketplacePage.payOnDelivery')}</span>}</td>
                <td>{new Date(o.created_at).toLocaleString()}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {o.status === 'placed' && <button className="btn small" onClick={() => fulfill(o.id)}>{t('marketplacePage.fulfill')}</button>}{' '}
                  {['placed', 'confirmed'].includes(o.status) && <button className="btn small secondary" onClick={() => cancel(o)}>{t('marketplacePage.cancel')}</button>}
                  {o.payment_status === 'refund_due' && <button className="btn small" onClick={() => markRefunded(o)}>{t('marketplacePage.markRefunded')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <p className="muted">{t('marketplacePage.noOrdersYet')}</p>}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

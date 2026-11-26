import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Badge, Modal, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import CreditPanel from '../components/CreditPanel.jsx';
import BrandingPanel from '../components/BrandingPanel.jsx';
import CouriersPanel from '../components/CouriersPanel.jsx';
import CustomerMessages from '../components/CustomerMessages.jsx';

const SYNC_EVENTS = ['marketplace:order_placed', 'marketplace:order_updated', 'marketplace:order_fulfilled', 'marketplace:order_cancelled', 'marketplace:order_paid'];

export default function Marketplace() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/marketplace/orders`).then((r) => setOrders(r.data)).catch(() => {});
  useEffect(() => { load(); }, [user.storeId]);

  // Shop profile: custom address (/shop/<slug>), tagline, category, location.
  const [profile, setProfile] = useState(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const toForm = (p) => ({ shopSlug: p.shop_slug || '', shopTagline: p.shop_tagline || '', category: p.category || '', city: p.city || '', address: p.address || '', customDomain: p.custom_domain || '', enabled: p.marketplace_enabled, domainTarget: p.domain_target, savedDomain: p.custom_domain || '' });
  const [domainCheck, setDomainCheck] = useState(null);
  const checkDomain = async () => {
    setDomainCheck({ checking: true });
    try { const { data } = await api.get(`/stores/${user.storeId}/custom-domain/check`); setDomainCheck(data); }
    catch { setDomainCheck({ error: true }); }
  };
  useEffect(() => {
    api.get(`/stores/${user.storeId}/marketplace-profile`).then((r) => setProfile(toForm(r.data))).catch(() => {});
  }, [user.storeId]);
  const saveProfile = async (e) => {
    e.preventDefault();
    setSavingProfile(true); setError('');
    try {
      const { enabled, domainTarget, savedDomain, ...body } = profile;
      const { data } = await api.patch(`/stores/${user.storeId}/marketplace-profile`, body);
      setProfile(toForm(data));
      setDomainCheck(null);
      showToast(t('marketplacePage.profileSaved'), 'success');
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.profileFailed'));
    } finally { setSavingProfile(false); }
  };
  const setP = (k) => (e) => setProfile({ ...profile, [k]: e.target.value });
  useRealtimeEvents(SYNC_EVENTS, () => load());

  // Review flow: View → Confirm (pickup/delivery) → Ready / Out for delivery → Fulfill.
  const [viewing, setViewing] = useState(null); // full order with items
  const [reviewMethod, setReviewMethod] = useState('delivery');
  const [couriers, setCouriers] = useState([]);
  useEffect(() => { api.get(`/stores/${user.storeId}/couriers`).then((r) => setCouriers(r.data)).catch(() => {}); }, [user.storeId]);
  const assignCourier = async (courierId) => {
    try {
      await api.patch(`/stores/${user.storeId}/marketplace/orders/${viewing.id}/courier`, { courierId: courierId || null });
      setViewing({ ...viewing, courier_id: courierId || null, courier_picked_at: null });
      showToast(t('marketplacePage.courierSet'), 'success');
    } catch (err) { showToast(err.response?.data?.error || t('creditPanel.failed'), 'error'); }
  };
  const [statusNote, setStatusNote] = useState('');
  const [busy, setBusy] = useState(false);
  const openOrder = async (o) => {
    setError('');
    try {
      const { data } = await api.get(`/stores/${user.storeId}/marketplace/orders/${o.id}`);
      setViewing(data);
      setReviewMethod(data.fulfilment_method || (data.delivery_address ? 'delivery' : 'pickup'));
      setStatusNote(data.status_note || '');
    } catch (err) { setError(err.response?.data?.error || t('marketplacePage.fulfillFailed')); }
  };
  const step = async (action, body, toastKey) => {
    setBusy(true); setError('');
    try {
      await api.patch(`/stores/${user.storeId}/marketplace/orders/${viewing.id}/${action}`, body);
      showToast(t(toastKey), 'success');
      setViewing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('marketplacePage.fulfillFailed'));
    } finally { setBusy(false); }
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

  // On the shop computer the page is served locally; customers use the public web address.
  const shopOrigin = import.meta.env.VITE_EDITION === 'desktop' ? (import.meta.env.VITE_PUBLIC_APP_URL || 'https://app.safestore.com.ng') : window.location.origin;
  const storefrontUrl = `${shopOrigin}/shop/${profile?.shopSlug || user.storeId}`;

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
                  <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{shopOrigin.replace(/^https?:\/\//, '')}/shop/</span>
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
              <div className="form-group">
                <label htmlFor="mp-domain">{t('marketplacePage.customDomain')}</label>
                <input id="mp-domain" value={profile.customDomain} onChange={setP('customDomain')} placeholder="shop.yourbusiness.com" />
                <span className="help-text">{t('marketplacePage.customDomainHelp')}</span>
              </div>
            </div>
            {profile.savedDomain && (
              <div className="alert info" style={{ fontSize: 13 }}>
                <strong>{t('marketplacePage.dnsTitle', { domain: profile.savedDomain })}</strong>
                <ol style={{ margin: '6px 0 6px 18px' }}>
                  <li>{t('marketplacePage.dnsStep1')}</li>
                  <li>{t('marketplacePage.dnsStep2')} <code>CNAME</code> · <code>{profile.savedDomain.split('.').length > 2 ? profile.savedDomain.split('.')[0] : '@'}</code> → <code>{profile.domainTarget}</code></li>
                  <li>{t('marketplacePage.dnsStep3')}</li>
                </ol>
                <button type="button" className="btn small secondary" onClick={checkDomain} disabled={domainCheck?.checking}>{t('marketplacePage.checkDns')}</button>{' '}
                {domainCheck && !domainCheck.checking && (domainCheck.pointsHere
                  ? <span>✅ {t('marketplacePage.dnsOk', { domain: profile.savedDomain })} <a href={`https://${profile.savedDomain}`} target="_blank" rel="noreferrer">https://{profile.savedDomain}</a></span>
                  : <span>⏳ {t('marketplacePage.dnsNotYet')}</span>)}
              </div>
            )}
            {['admin', 'manager'].includes(user.role) && <button className="btn" type="submit" disabled={savingProfile}>{t('marketplacePage.saveProfile')}</button>}
          </form>
        )}
      </div>

      <BrandingPanel onToast={showToast} shopUrl={storefrontUrl} />

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
                <td><Badge status={o.status} />{o.fulfilment_method && <span className="muted" style={{ fontSize: 12 }}> · {t(`marketplacePage.method_${o.fulfilment_method}`)}</span>} {o.payment_status === 'refund_due' ? <span className="badge pending">{t('marketplacePage.refundDue')}</span> : o.payment_status === 'refunded' ? <span className="badge closed">{t('marketplacePage.refunded')}</span> : o.payment_status === 'paid' ? <span className="badge active">{t(o.payment_method === 'online' ? 'marketplacePage.paidOnline' : o.payment_method === 'credit' ? 'marketplacePage.paidByGuarantor' : o.payment_method === 'transfer' ? 'marketplacePage.paidByTransfer' : 'marketplacePage.cashCollected')}</span> : o.payment_method === 'online' ? <span className="badge pending">{t('marketplacePage.awaitingPayment')}</span> : <span className="badge closed">{o.payment_method === 'credit' ? t('marketplacePage.onCredit') : o.payment_method === 'transfer' ? t('marketplacePage.checkTransfer') : o.payment_method === 'on_pickup' ? t('marketplacePage.payOnPickup') : t('marketplacePage.payOnDelivery')}</span>}</td>
                <td>{new Date(o.created_at).toLocaleString()}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className={`btn small${o.status === 'placed' ? '' : ' secondary'}`} onClick={() => openOrder(o)}>{o.status === 'placed' ? t('marketplacePage.review') : t('marketplacePage.view')}</button>{' '}
                  {['placed', 'confirmed', 'ready_for_pickup', 'out_for_delivery'].includes(o.status) && <button className="btn small secondary" onClick={() => cancel(o)}>{t('marketplacePage.cancel')}</button>}
                  {o.payment_status === 'refund_due' && <button className="btn small" onClick={() => markRefunded(o)}>{t('marketplacePage.markRefunded')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <p className="muted">{t('marketplacePage.noOrdersYet')}</p>}
      </div>
      {import.meta.env.VITE_EDITION !== 'desktop' && <CustomerMessages />}
      <CreditPanel onToast={showToast} />
      <CouriersPanel couriers={couriers} reload={() => api.get(`/stores/${user.storeId}/couriers`).then((r) => setCouriers(r.data))} onToast={showToast} />

      {viewing && (
        <Modal title={t('marketplacePage.orderTitle', { ref: viewing.id.slice(0, 8).toUpperCase() })} onClose={() => setViewing(null)}>
          <p><strong>{viewing.customer_name}</strong>{viewing.customer_phone && <> · <a href={`tel:${viewing.customer_phone}`}>{viewing.customer_phone}</a></>}{viewing.customer_email && <> · {viewing.customer_email}</>}</p>
          <p className="muted">{t('marketplacePage.deliveryAddress')}: {viewing.delivery_address || '—'}</p>
          {viewing.customer_note && <p className="muted">{t('marketplacePage.customerNote')}: {viewing.customer_note}</p>}
          <table className="mt-1">
            <thead><tr><th>{t('marketplacePage.item')}</th><th>{t('marketplacePage.qty')}</th><th>{t('marketplacePage.total')}</th></tr></thead>
            <tbody>{(viewing.items || []).map((i) => <tr key={i.id}><td>{i.product_name}</td><td>{i.quantity}</td><td>{formatCurrency(i.line_total)}</td></tr>)}</tbody>
          </table>
          <p className="mt-1"><strong>{t('marketplacePage.total')}: {formatCurrency(viewing.total)}</strong> · <Badge status={viewing.status} /></p>

          <p className="mt-1">{t('marketplacePage.customerChose')}: <strong>{reviewMethod === 'delivery' ? `🚚 ${t('marketplacePage.method_delivery')}` : `🏪 ${t('marketplacePage.method_pickup')}`}</strong></p>
          {reviewMethod === 'delivery' && ['confirmed', 'out_for_delivery'].includes(viewing.status) && couriers.length > 0 && (
            <div className="form-group">
              <label htmlFor="mp-courier">🛵 {t('marketplacePage.courier')}</label>
              <select id="mp-courier" value={viewing.courier_id || ''} onChange={(e) => assignCourier(e.target.value)}>
                <option value="">{t('marketplacePage.ownRider')}</option>
                {couriers.filter((c) => c.active).map((c) => <option key={c.partner_id} value={c.partner_id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
              </select>
              {viewing.courier_picked_at && <p className="muted" style={{ fontSize: 12 }}>✅ {t('marketplacePage.courierPicked')}</p>}
            </div>
          )}
          {['placed', 'confirmed'].includes(viewing.status) && (
            <div className="form-group mt-1">
              <label htmlFor="mp-note">{t('marketplacePage.noteForCustomer')}</label>
              <input id="mp-note" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} maxLength={300}
                placeholder={(viewing.fulfilment_method || reviewMethod) === 'delivery' ? t('marketplacePage.notePhDelivery') : t('marketplacePage.notePhPickup')} />
            </div>
          )}
          {viewing.status_note && !['placed', 'confirmed'].includes(viewing.status) && <p className="muted">{t('marketplacePage.noteForCustomer')}: {viewing.status_note}</p>}

          <div className="modal-actions">
            {viewing.status === 'placed' && <button className="btn" disabled={busy} onClick={() => step('confirm', { method: reviewMethod, note: statusNote }, 'marketplacePage.confirmedToast')}>{reviewMethod === 'delivery' ? t('marketplacePage.confirmDelivery') : t('marketplacePage.confirmPickup')}</button>}
            {viewing.status === 'confirmed' && <button className="btn" disabled={busy} onClick={() => step('dispatch', { note: statusNote }, 'marketplacePage.dispatchedToast')}>{viewing.fulfilment_method === 'delivery' ? t('marketplacePage.outForDelivery') : t('marketplacePage.readyForPickup')}</button>}
            {['ready_for_pickup', 'out_for_delivery'].includes(viewing.status) && <button className="btn" disabled={busy} onClick={() => step('fulfill', {}, 'marketplacePage.orderFulfilled')}>{viewing.status === 'out_for_delivery' ? t('marketplacePage.markDelivered') : t('marketplacePage.markCollected')}</button>}
            {viewing.tracking_token && <a className="btn secondary" href={`/track/${viewing.tracking_token}`} target="_blank" rel="noreferrer">{t('marketplacePage.trackingPage')}</a>}
            <button className="btn secondary" onClick={() => setViewing(null)}>{t('common.close', { defaultValue: 'Close' })}</button>
          </div>
        </Modal>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

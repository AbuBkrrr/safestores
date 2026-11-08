import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { formatCurrency as format } from '../utils/currency.js';
import { LanguageSwitcher } from '../components/Layout.jsx';
import { BrandFooter } from '../components/ui.jsx';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const client = axios.create({ baseURL: API_BASE });
// Share links point at the API's /share/shop page, which carries the
// Open Graph tags WhatsApp/Facebook/X read for link previews (they don't
// run JavaScript), then redirects people straight here.
const SHARE_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/api\/?$/, '') || window.location.origin;

export default function Storefront() {
  const { t } = useTranslation();
  const { storeId } = useParams();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState({}); // productId -> quantity
  const [customer, setCustomer] = useState(() => {
    const raw = localStorage.getItem(`ss_customer_${storeId}`);
    return raw ? JSON.parse(raw) : null;
  });
  const [authMode, setAuthMode] = useState('login'); // login | signup
  const [showAuth, setShowAuth] = useState(false);
  const [authForm, setAuthForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);
  const [myOrders, setMyOrders] = useState([]);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');

  const currency = store ? { code: store.currency_code, symbol: store.currency_symbol } : undefined;
  const formatCurrency = (n) => format(n, currency);

  useEffect(() => {
    client.get(`/public/stores/${storeId}`).then((r) => setStore(r.data)).catch(() => setStore(null));
    client.get(`/marketplace/${storeId}/products`).then((r) => setProducts(r.data)).catch(() => setError(t('storefrontPage.orderFailed')));
  }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!store) return;
    document.title = `${store.name} — ${t('storefrontPage.title')}`;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.content = t('storefrontPage.metaDescription', { name: store.name, city: store.city || '' });
  }, [store, t]);

  useEffect(() => {
    if (!customer) return;
    client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } }).then((r) => setMyOrders(r.data)).catch(() => {});
  }, [customer, storeId]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const path = authMode === 'login' ? 'login' : 'signup';
      const { data } = await client.post(`/marketplace/${storeId}/${path}`, authForm);
      const c = { ...data.user, token: data.token };
      localStorage.setItem(`ss_customer_${storeId}`, JSON.stringify(c));
      setCustomer(c);
      setShowAuth(false);
    } catch (err) {
      setError(err.response?.data?.error || t('storefrontPage.orderFailed'));
    }
  };

  const logout = () => {
    localStorage.removeItem(`ss_customer_${storeId}`);
    setCustomer(null);
  };

  const addToCart = (productId) => setCart((c) => ({ ...c, [productId]: (c[productId] || 0) + 1 }));
  const removeFromCart = (productId) => setCart((c) => {
    const next = { ...c };
    if (next[productId] > 1) next[productId] -= 1; else delete next[productId];
    return next;
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => !q || [p.name, p.category, p.brand].some((v) => v && String(v).toLowerCase().includes(q)));
  }, [products, query]);

  const cartItems = Object.entries(cart).map(([productId, quantity]) => {
    const product = products.find((p) => p.id === productId);
    return product ? { ...product, quantity } : null;
  }).filter(Boolean);
  const cartTotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const placeOrder = async () => {
    setMessage(''); setError('');
    if (!customer && !guestName) {
      setError(t('storefrontPage.pleaseEnterNameGuest'));
      return;
    }
    try {
      const body = { items: cartItems.map((i) => ({ productId: i.id, quantity: i.quantity })), deliveryAddress };
      const config = {};
      if (customer) {
        config.headers = { Authorization: `Bearer ${customer.token}` };
      } else {
        body.guestName = guestName;
        body.guestEmail = guestEmail || undefined;
        body.guestPhone = guestPhone || undefined;
      }
      const { data } = await client.post(`/marketplace/${storeId}/orders`, body, config);
      setCart({});
      setPlaced(data);
      setMessage(t('storefrontPage.orderPlaced'));
      if (customer) {
        client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } }).then((r) => setMyOrders(r.data));
      }
    } catch (err) {
      setError(err.response?.data?.error || t('storefrontPage.orderFailed'));
    }
  };

  const shareUrl = `${SHARE_BASE}/share/shop/${storeId}`;
  const shareShop = async () => {
    if (navigator.share) { try { await navigator.share({ title: store?.name, url: shareUrl }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(shareUrl); setMessage(t('storefrontPage.linkCopied')); } catch { /* ignore */ }
  };
  const whatsappOrder = () => {
    const lines = [t('storefrontPage.waGreeting', { store: store?.name || '' }), '', ...cartItems.map((i) => `• ${i.name} × ${i.quantity}`), '', `${t('storefrontPage.total')} ${formatCurrency(cartTotal)}`];
    if (deliveryAddress) lines.push(`${t('storefrontPage.deliveryAddress')}: ${deliveryAddress}`);
    window.open(`https://wa.me/${String(store?.phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');
  };
  const trackingPath = placed?.tracking_token ? `/track/${placed.tracking_token}` : null;

  return (
    <div className="storefront">
      <header className="storefront-header">
        <div>
          <h1>{store?.name || t('storefrontPage.title')}</h1>
          {store && <p className="muted">{[store.category, store.city].filter(Boolean).join(' · ')}{store.phone ? ` · ${store.phone}` : ''}</p>}
        </div>
        <div className="flex">
          <div style={{ width: 140 }}><LanguageSwitcher /></div>
          <button className="btn small secondary" onClick={shareShop}>{t('storefrontPage.share')}</button>
          {customer
            ? <span>{t('storefrontPage.hiName', { name: customer.name })} · <button className="btn small secondary" onClick={logout}>{t('storefrontPage.logOut')}</button></span>
            : <button className="btn small secondary" onClick={() => setShowAuth((s) => !s)}>{t('storefrontPage.logIn')}</button>}
        </div>
      </header>

      {!customer && showAuth && (
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="auth-tabs">
            <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')}>{t('storefrontPage.logIn')}</button>
            <button className={authMode === 'signup' ? 'active' : ''} onClick={() => setAuthMode('signup')}>{t('storefrontPage.signUp')}</button>
          </div>
          <form onSubmit={handleAuth}>
            {authMode === 'signup' && <div className="form-group"><input aria-label={t('storefrontPage.fullName')} placeholder={t('storefrontPage.fullName')} value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} required /></div>}
            <div className="form-group"><input type="email" aria-label={t('storefrontPage.email')} placeholder={t('storefrontPage.email')} value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} required /></div>
            {authMode === 'signup' && <div className="form-group"><input aria-label={t('storefrontPage.phoneOptional')} placeholder={t('storefrontPage.phoneOptional')} value={authForm.phone} onChange={(e) => setAuthForm({ ...authForm, phone: e.target.value })} /></div>}
            <div className="form-group"><input type="password" aria-label={t('storefrontPage.password')} placeholder={t('storefrontPage.password')} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required /></div>
            <button className="btn" type="submit">{authMode === 'login' ? t('storefrontPage.logIn') : t('storefrontPage.signUp')}</button>
          </form>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      <div className="storefront-grid">
        <section>
          <input className="storefront-search" aria-label={t('common.search')} placeholder={t('storefrontPage.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="product-grid">
            {visible.map((p) => (
              <div key={p.id} className="product-tile">
                {p.image_url && <img src={p.image_url} alt="" loading="lazy" />}
                <div className="pt-name">{p.name}</div>
                <div className="muted">{p.category}</div>
                <div className="pt-foot">
                  <strong>{formatCurrency(p.price)}</strong>
                  {p.in_stock
                    ? <button className="btn small" onClick={() => addToCart(p.id)}>{cart[p.id] ? `+ (${cart[p.id]})` : t('storefrontPage.add')}</button>
                    : <span className="muted">{t('storefrontPage.outOfStockTag')}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="card storefront-cart">
          <h2>{t('storefrontPage.yourCart')}</h2>
          {placed && (
            <div className="alert success">
              {message}{' '}
              {trackingPath && <Link to={trackingPath}>{t('storefrontPage.trackOrder')}</Link>}
            </div>
          )}
          {!placed && message && <div className="alert info">{message}</div>}
          {cartItems.length === 0 && !placed && <p className="muted">{t('storefrontPage.cartEmpty')}</p>}
          {cartItems.map((i) => (
            <div key={i.id} className="flex-between" style={{ padding: '6px 0' }}>
              <span>{i.name} × {i.quantity}</span>
              <span>{formatCurrency(i.price * i.quantity)} <button className="btn small secondary" aria-label={`${t('storefrontPage.remove')} ${i.name}`} onClick={() => removeFromCart(i.id)}>−</button></span>
            </div>
          ))}
          {cartItems.length > 0 && (
            <div className="mt-1">
              <div style={{ fontWeight: 700, fontSize: 18 }}>{t('storefrontPage.total')} {formatCurrency(cartTotal)}</div>
              <div className="form-group mt-1"><input aria-label={t('storefrontPage.deliveryAddress')} placeholder={t('storefrontPage.deliveryAddress')} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} /></div>
              {!customer && (
                <>
                  <div className="form-group"><input aria-label={t('storefrontPage.yourNameGuest')} placeholder={t('storefrontPage.yourNameGuest')} value={guestName} onChange={(e) => setGuestName(e.target.value)} /></div>
                  <div className="form-group"><input type="email" aria-label={t('invitesPage.emailOptional')} placeholder={t('invitesPage.emailOptional')} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} /></div>
                  <div className="form-group"><input aria-label={t('storefrontPage.phoneOptional')} placeholder={t('storefrontPage.phoneOptional')} value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} inputMode="tel" /></div>
                </>
              )}
              <p className="muted">{t('storefrontPage.payOnCollection')}</p>
              <div className="flex">
                <button className="btn" onClick={placeOrder}>{t('storefrontPage.placeOrder')}</button>
                {store?.phone && <button className="btn" style={{ background: '#25D366' }} onClick={whatsappOrder}>{t('storefrontPage.orderOnWhatsApp')}</button>}
              </div>
            </div>
          )}

          {customer && myOrders.length > 0 && (
            <div className="mt-1">
              <h3>{t('storefrontPage.yourOrders')}</h3>
              {myOrders.map((o) => (
                <div key={o.id} className="flex-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <span>{formatCurrency(o.total)} — {new Date(o.created_at).toLocaleDateString()}</span>
                  <span>{o.tracking_token ? <Link to={`/track/${o.tracking_token}`}>{t(`common.status.${o.status}`, { defaultValue: o.status })}</Link> : t(`common.status.${o.status}`, { defaultValue: o.status })}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
      <BrandFooter />
    </div>
  );
}

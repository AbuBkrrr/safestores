import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { LanguageSwitcher } from '../components/Layout.jsx';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const client = axios.create({ baseURL: API_BASE });

export default function Storefront() {
  const { t } = useTranslation();
  const { storeId } = useParams();
  const { formatCurrency } = useCurrency();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({}); // productId -> quantity
  const [customer, setCustomer] = useState(() => {
    const raw = localStorage.getItem(`ss_customer_${storeId}`);
    return raw ? JSON.parse(raw) : null;
  });
  const [authMode, setAuthMode] = useState('login'); // login | signup
  const [authForm, setAuthForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [message, setMessage] = useState('');
  const [myOrders, setMyOrders] = useState([]);

  useEffect(() => {
    client.get(`/marketplace/${storeId}/products`).then((r) => setProducts(r.data));
  }, [storeId]);

  useEffect(() => {
    if (customer) {
      client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } })
        .then((r) => setMyOrders(r.data)).catch(() => {});
    }
  }, [customer, storeId]);

  const saveCustomer = (data) => {
    const stored = { token: data.token, ...data.user };
    localStorage.setItem(`ss_customer_${storeId}`, JSON.stringify(stored));
    setCustomer(stored);
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setMessage('');
    try {
      const path = authMode === 'login' ? 'login' : 'signup';
      const { data } = await client.post(`/marketplace/${storeId}/${path}`, authForm);
      saveCustomer(data);
    } catch (err) {
      setMessage(err.response?.data?.error || t('storefrontPage.somethingWentWrong'));
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

  const cartItems = Object.entries(cart).map(([productId, quantity]) => {
    const product = products.find((p) => p.id === productId);
    return product ? { ...product, quantity } : null;
  }).filter(Boolean);
  const cartTotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');

  const placeOrder = async () => {
    setMessage('');
    if (!customer && !guestName) {
      setMessage(t('storefrontPage.pleaseEnterNameGuest'));
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
      await client.post(`/marketplace/${storeId}/orders`, body, config);
      setCart({});
      setMessage(`${t('storefrontPage.orderPlaced')} ${customer ? t('storefrontPage.trackBelow') : ''}`);
      if (customer) {
        client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } }).then((r) => setMyOrders(r.data));
      }
    } catch (err) {
      setMessage(err.response?.data?.error || t('storefrontPage.orderFailed'));
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 16 }}>
        <h1>{t('storefrontPage.title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 140 }}><LanguageSwitcher /></div>
          {customer ? (
            <div>{t('storefrontPage.hiName', { name: customer.name })} · <button onClick={logout}>{t('storefrontPage.logOut')}</button></div>
          ) : null}
        </div>
      </div>

      {!customer && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 20, maxWidth: 380 }}>
          <div style={{ marginBottom: 8 }}>
            <button onClick={() => setAuthMode('login')} style={{ fontWeight: authMode === 'login' ? 700 : 400 }}>{t('storefrontPage.logIn')}</button>{' '}
            <button onClick={() => setAuthMode('signup')} style={{ fontWeight: authMode === 'signup' ? 700 : 400 }}>{t('storefrontPage.signUp')}</button>
          </div>
          {message && <p style={{ color: 'crimson' }}>{message}</p>}
          <form onSubmit={handleAuth}>
            {authMode === 'signup' && (
              <input placeholder={t('storefrontPage.fullName')} value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} required style={{ display: 'block', width: '100%', marginBottom: 8 }} />
            )}
            <input type="email" placeholder={t('storefrontPage.email')} value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} required style={{ display: 'block', width: '100%', marginBottom: 8 }} />
            {authMode === 'signup' && (
              <input placeholder={t('storefrontPage.phoneOptional')} value={authForm.phone} onChange={(e) => setAuthForm({ ...authForm, phone: e.target.value })} style={{ display: 'block', width: '100%', marginBottom: 8 }} />
            )}
            <input type="password" placeholder={t('storefrontPage.password')} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required style={{ display: 'block', width: '100%', marginBottom: 8 }} />
            <button type="submit">{authMode === 'login' ? t('storefrontPage.logIn') : t('storefrontPage.signUp')}</button>
          </form>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <h2>{t('storefrontPage.products')}</h2>
          {products.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
              <div>
                <strong>{p.name}</strong> {!p.in_stock && <span style={{ color: 'crimson' }}> {t('storefrontPage.outOfStockTag')}</span>}
                <div style={{ color: '#777', fontSize: 13 }}>{p.category} {p.location ? `· ${p.location}` : ''}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div>{formatCurrency(p.price)}</div>
                <button disabled={!p.in_stock} onClick={() => addToCart(p.id)}>{t('storefrontPage.add')}</button>
              </div>
            </div>
          ))}
        </div>

        <div>
          <h2>{t('storefrontPage.yourCart')}</h2>
          {cartItems.length === 0 && <p style={{ color: '#777' }}>{t('storefrontPage.cartEmpty')}</p>}
          {cartItems.map((i) => (
            <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{i.name} × {i.quantity}</span>
              <span>{formatCurrency(i.price * i.quantity)} <button onClick={() => removeFromCart(i.id)}>−</button></span>
            </div>
          ))}
          {cartItems.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700 }}>{t('storefrontPage.total')} {formatCurrency(cartTotal)}</div>
              <input placeholder={t('storefrontPage.deliveryAddress')} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} style={{ display: 'block', width: '100%', margin: '8px 0' }} />
              {!customer && (
                <div style={{ marginBottom: 8 }}>
                  <input placeholder={t('storefrontPage.yourNameGuest')} value={guestName} onChange={(e) => setGuestName(e.target.value)} style={{ display: 'block', width: '100%', marginBottom: 6 }} />
                  <input placeholder={t('invitesPage.emailOptional')} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} style={{ display: 'block', width: '100%', marginBottom: 6 }} />
                  <input placeholder={t('storefrontPage.phoneOptional')} value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} style={{ display: 'block', width: '100%', marginBottom: 6 }} />
                </div>
              )}
              <button onClick={placeOrder}>{t('storefrontPage.placeOrder')}</button>
            </div>
          )}
          {message && <p style={{ color: 'green' }}>{message}</p>}

          {customer && myOrders.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3>{t('storefrontPage.yourOrders')}</h3>
              {myOrders.map((o) => (
                <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
                  <span>{formatCurrency(o.total)} — {new Date(o.created_at).toLocaleDateString()}</span>
                  <span>{t(`common.status.${o.status}`, { defaultValue: o.status })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

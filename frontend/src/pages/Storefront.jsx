import TransferDetails from '../components/TransferDetails.jsx';
import AskShopDialog from '../components/AskShopDialog.jsx';
import InstallMarketBanner from '../components/InstallMarketBanner.jsx';
import { shopper } from '../utils/shopperLocal.js';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { formatCurrency as format } from '../utils/currency.js';
import { shopThemeVars, useShopTheme } from '../utils/shopTheme.js';
import CreditKycSteps from '../components/CreditKycSteps.jsx';
import { LanguageSwitcher } from '../components/Layout.jsx';
import { BrandFooter } from '../components/ui.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const client = axios.create({ baseURL: API_BASE });
// Share links point at the API's /share/shop page, which carries the
// Open Graph tags WhatsApp/Facebook/X read for link previews (they don't
// run JavaScript), then redirects people straight here.
const SHARE_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/api\/?$/, '') || window.location.origin;

export default function Storefront() {
  const { t } = useTranslation();
  const params = useParams();
  // On a store's custom domain the shop is fixed by the host (see main.jsx).
  const storeId = window.__SHOP_DOMAIN_STORE__ || params.storeId;
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
  const [confirmPw, setConfirmPw] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState(null);
  const [ask, setAsk] = useState(null); // { kind, product }
  const [, setFavTick] = useState(0);
  const [myOrders, setMyOrders] = useState([]);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [payMethod, setPayMethod] = useState('');

  const currency = store ? { code: store.currency_code, symbol: store.currency_symbol } : undefined;
  const canPayOnline = !!store?.payments?.online;
  const canPayOnDelivery = store ? store.payments?.payOnDelivery !== false : true;
  // payMethod: 'online' (pay now) or 'cash' (pay when delivered / collected).
  const [receive, setReceive] = useState('delivery');
  // Guaranteed credit (bank, cooperative, PFA, employer…) — see creditController.
  const [credit, setCredit] = useState({ guarantors: [], account: null });
  const [applyForm, setApplyForm] = useState(null); // { guarantorId, memberRef, requestedLimit } while open
  const creditOk = credit.account?.status === 'approved';
  const canTransfer = !!store?.payments?.transfer;
  const payOptions = [canPayOnline && 'online', canTransfer && 'transfer', canPayOnDelivery && 'cash', creditOk && 'credit'].filter(Boolean);
  const payChoice = payOptions.includes(payMethod) ? payMethod : payOptions[0];
  const method = ['online', 'credit', 'transfer'].includes(payChoice) ? payChoice : receive === 'pickup' ? 'on_pickup' : 'on_delivery';
  const payLabel = (o) => (o === 'online' ? `💳 ${t('storefrontPage.payNowOnline')}`
    : o === 'transfer' ? `🏦 ${t('storefrontPage.payByTransfer')}`
    : o === 'credit' ? `🤝 ${t('storefrontPage.buyOnCredit', { available: format(credit.account?.available || 0, currency) })}`
      : `💵 ${receive === 'pickup' ? t('storefrontPage.payOnPickup') : t('storefrontPage.payOnDelivery')}`);
  const formatCurrency = (n) => format(n, currency);

  useEffect(() => {
    client.get(`/public/stores/${storeId}`).then((r) => {
      setStore(r.data);
      shopper.visitStore({ id: r.data.id, name: r.data.name, city: r.data.city, slug: r.data.shop_slug, logo: r.data.shop_logo_url });
    }).catch(() => setStore(null));
    client.get(`/marketplace/${storeId}/products`).then((r) => {
      setProducts(r.data);
      // Opened from the shopper app with "add this item": it is in the cart already.
      const add = new URLSearchParams(window.location.search).get('add');
      if (add && r.data.some((p) => p.id === add && p.in_stock)) setCart((c) => ({ ...c, [add]: c[add] || 1 }));
    }).catch(() => setError(t('storefrontPage.orderFailed')));
  }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!store) return;
    document.title = `${store.name} — ${t('storefrontPage.title')}`;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.content = t('storefrontPage.metaDescription', { name: store.name, city: store.city || '' });
  }, [store, t]);

  const loadCredit = () => client.get(`/marketplace/${storeId}/credit`, customer ? { headers: { Authorization: `Bearer ${customer.token}` } } : {})
    .then((r) => setCredit(r.data)).catch(() => {});
  useEffect(() => { loadCredit(); }, [customer, storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const submitCredit = async (e) => {
    e.preventDefault(); setError('');
    try {
      await client.post(`/marketplace/${storeId}/credit/apply`, applyForm, { headers: { Authorization: `Bearer ${customer.token}` } });
      setApplyForm(null); setMessage(t('storefrontPage.creditApplied')); loadCredit();
    } catch (err) { setError(err.response?.data?.error || t('storefrontPage.orderFailed')); }
  };

  useEffect(() => {
    if (!customer) return;
    client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } }).then((r) => setMyOrders(r.data)).catch(() => {});
  }, [customer, storeId]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    if (authMode === 'signup' && authForm.password !== confirmPw) {
      setError(t('storefrontPage.passwordsDontMatch'));
      return;
    }
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

  const stepFor = (productId) => (['weight', 'volume', 'length'].includes(products.find((x) => x.id === productId)?.sold_by) ? 0.5 : 1);
  const addToCart = (productId) => setCart((c) => ({ ...c, [productId]: Math.round(((c[productId] || 0) + stepFor(productId)) * 1000) / 1000 }));
  const removeFromCart = (productId) => setCart((c) => {
    const next = { ...c };
    const st = stepFor(productId);
    if (next[productId] > st) next[productId] = Math.round((next[productId] - st) * 1000) / 1000; else delete next[productId];
    return next;
  });

  const [category, setCategory] = useState('');
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(), [products]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => (!category || p.category === category)
      && (!q || [p.name, p.category, p.brand].some((v) => v && String(v).toLowerCase().includes(q))));
  }, [products, query, category]);
  const cartCount = Object.values(cart).reduce((n, q) => n + q, 0);
  // Opened via the long /shop/<id> link but the store has a custom address: show the nicer one.
  useEffect(() => {
    if (!window.__SHOP_DOMAIN_STORE__ && store?.shop_slug && storeId !== store.shop_slug) window.history.replaceState(null, '', `/shop/${store.shop_slug}`);
  }, [store, storeId]);

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
    if (receive === 'delivery' && !deliveryAddress.trim()) {
      setError(t('storefrontPage.addressRequired'));
      return;
    }
    if (method === 'online' && !customer && !guestEmail) {
      setError(t('storefrontPage.emailForPayment'));
      return;
    }
    try {
      const body = { items: cartItems.map((i) => ({ productId: i.id, quantity: i.quantity })), deliveryAddress: receive === 'delivery' ? deliveryAddress : undefined, paymentMethod: method, fulfilmentMethod: receive };
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
      setPlaced(data); // tracking link stays available even if starting payment fails
      shopper.addOrder({ token: data.tracking_token, storeId: store.id, storeName: store.name, total: data.total, at: Date.now(),
        items: cartItems.map((i) => ({ id: i.id, name: i.name, price: i.price, image_url: i.image_url, storeId: store.id, storeName: store.name })) });
      if (method === 'credit') loadCredit();
      if (method === 'online') {
        // Paystack checkout: the money goes straight to this store's bank.
        const pay = await client.post(`/marketplace/orders/${data.tracking_token}/pay`, { email: customer?.email || guestEmail });
        window.location.assign(pay.data.authorizationUrl);
        return;
      }
      setPlaced(data);
      setMessage(t('storefrontPage.orderPlaced'));
      if (customer) {
        client.get(`/marketplace/${storeId}/my-orders`, { headers: { Authorization: `Bearer ${customer.token}` } }).then((r) => setMyOrders(r.data));
      }
    } catch (err) {
      setError(err.response?.data?.error || t('storefrontPage.orderFailed'));
    }
  };

  const shareUrl = `${SHARE_BASE}/share/shop/${store?.shop_slug || storeId}`;
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
  useShopTheme(store);

  return (
    <div className={`storefront${store?.shop_bg_color || store?.shop_bg_image_url ? ' sf-branded-bg' : ''}`} data-sf-theme={store?.shop_theme || undefined} style={shopThemeVars(store)}>
      <header className="storefront-header">
        <div className="sf-hero">
          {store?.shop_logo_url
            ? <img className="sf-avatar sf-logo" src={store.shop_logo_url} alt={store.name} />
            : <div className="sf-avatar" aria-hidden="true">{(store?.name || 'S').trim().charAt(0).toUpperCase()}</div>}
          <div>
            <h1>{store?.name || t('storefrontPage.title')}</h1>
            {store?.shop_tagline && <p className="sf-tagline">{store.shop_tagline}</p>}
            {store && (
              <div className="sf-chips">
                {store.category && <span className="sf-chip">🏷️ {store.category}</span>}
                {(store.city || store.address) && <span className="sf-chip">📍 {[store.address, store.city].filter(Boolean).join(', ')}</span>}
                {store.phone && <a className="sf-chip" href={`tel:${store.phone}`}>📞 {store.phone}</a>}
              </div>
            )}
          </div>
        </div>
        <div className="flex sf-actions">
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
            <div className="form-group"><PasswordInput aria-label={t('storefrontPage.password')} placeholder={t('storefrontPage.password')} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} required /></div>
            {authMode === 'signup' && <div className="form-group"><PasswordInput aria-label={t('storefrontPage.confirmPassword')} placeholder={t('storefrontPage.confirmPassword')} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></div>}
            <button className="btn" type="submit">{authMode === 'login' ? t('storefrontPage.logIn') : t('storefrontPage.signUp')}</button>
          </form>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      <div className="storefront-grid">
        <section>
          <input className="storefront-search" aria-label={t('common.search')} placeholder={t('storefrontPage.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {categories.length > 1 && (
            <div className="sf-cats" role="tablist" aria-label={t('storefrontPage.categories')}>
              <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory('')}>{t('storefrontPage.allCategories')}</button>
              {categories.map((c) => <button type="button" key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          {products.length > 0 && visible.length === 0 && <p className="muted sf-empty">{t('storefrontPage.noMatches')}</p>}
          {store && <p className="small"><button type="button" className="link-btn" onClick={() => setAsk({ kind: 'request' })}>🙋 {t('shopper.cantFind')}</button></p>}
          <InstallMarketBanner />
          {ask && store && <AskShopDialog store={store} product={ask.product} kind={ask.kind} onClose={() => setAsk(null)} />}
          <div className="product-grid">
            {visible.map((p) => (
              <div key={p.id} className={`product-tile${p.in_stock ? '' : ' out'}`}>
                {p.image_url
                  ? <img src={p.image_url} alt="" loading="lazy" />
                  : <div className="pt-ph" aria-hidden="true">{p.name.trim().charAt(0).toUpperCase()}</div>}
                <div className="pt-name">{p.name}</div>
                {p.category && <div className="muted pt-cat">{p.category}</div>}
                <div className="flex" style={{ gap: 6 }}>
                  <button type="button" className="link-btn small" onClick={() => setAsk({ kind: 'question', product: p })}>💬 {t('shopper.ask')}</button>
                  <button type="button" className="link-btn small" aria-label={t('shopper.save')} onClick={() => { shopper.toggleFav('items', { id: p.id, name: p.name, price: p.price, image_url: p.image_url, storeId: store.id, storeName: store.name }); setFavTick((n) => n + 1); }}>{shopper.isFav('items', p.id) ? '❤️' : '🤍'}</button>
                </div>
                <div className="pt-foot">
                  <strong>
                    {p.on_sale && <span className="badge active" style={{ marginRight: 4 }}>{p.promo_label || t('shopper.sale')}</span>}
                    {formatCurrency(p.price)}{p.sold_by && p.sold_by !== 'unit' ? <span className="muted" style={{ fontWeight: 400 }}>/{p.unit}</span> : null}
                    {p.on_sale && <s className="muted" style={{ fontWeight: 400, marginLeft: 4, fontSize: 12 }}>{formatCurrency(p.regular_price)}</s>}
                  </strong>
                  {!p.in_stock
                    ? <span className="muted">{t('storefrontPage.outOfStockTag')}</span>
                    : cart[p.id]
                      ? (
                        <span className="pt-step">
                          <button type="button" aria-label={`${t('storefrontPage.remove')} ${p.name}`} onClick={() => removeFromCart(p.id)}>−</button>
                          <span aria-live="polite">{cart[p.id]}{p.sold_by && p.sold_by !== 'unit' ? ` ${p.unit}` : ''}</span>
                          <button type="button" aria-label={`${t('storefrontPage.add')} ${p.name}`} onClick={() => addToCart(p.id)}>+</button>
                        </span>
                      )
                      : <button className="btn small" onClick={() => addToCart(p.id)}>{t('storefrontPage.add')}</button>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="card storefront-cart" id="sf-cart">
          <h2>{t('storefrontPage.yourCart')}{cartCount > 0 && <span className="sf-count">{cartCount}</span>}</h2>
          {placed && (
            <div className="alert success">
              {message}{' '}
              {trackingPath && <Link to={trackingPath}>{t('storefrontPage.trackOrder')}</Link>}
              {placed.transfer && <TransferDetails transfer={placed.transfer} amount={formatCurrency(placed.total)} reference={String(placed.id || '').slice(0, 8).toUpperCase()} />}
              {placed.transfer && placed.tracking_token && (placed.transfer_sent_at
                ? <div className="alert success">✅ {t('trackPage.paymentSentDone')}</div>
                : <button type="button" className="btn" style={{ width: '100%', marginTop: 8 }}
                    onClick={() => client.post(`/public/marketplace-orders/${placed.tracking_token}/payment-sent`)
                      .then((r) => setPlaced((cur) => ({ ...cur, transfer_sent_at: r.data.transfer_sent_at || new Date().toISOString() }))).catch(() => {})}>
                    💸 {t('trackPage.paymentSentButton')}</button>)}
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
              <fieldset className="pay-choice mt-1">
                <legend>{t('storefrontPage.howToReceive')}</legend>
                <label><input type="radio" name="receive" checked={receive === 'delivery'} onChange={() => setReceive('delivery')} /> 🚚 {t('storefrontPage.receiveDelivery')}</label>
                <label><input type="radio" name="receive" checked={receive === 'pickup'} onChange={() => setReceive('pickup')} /> 🏪 {t('storefrontPage.receivePickup')}</label>
              </fieldset>
              {receive === 'delivery'
                ? <div className="form-group"><input aria-label={t('storefrontPage.deliveryAddress')} placeholder={t('storefrontPage.deliveryAddress')} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} required /></div>
                : <p className="muted" style={{ fontSize: 13 }}>📍 {t('storefrontPage.pickupFrom', { place: [store?.address, store?.city].filter(Boolean).join(', ') || store?.name || '' })}</p>}
              {!customer && (
                <>
                  <div className="form-group"><input aria-label={t('storefrontPage.yourNameGuest')} placeholder={t('storefrontPage.yourNameGuest')} value={guestName} onChange={(e) => setGuestName(e.target.value)} /></div>
                  <div className="form-group"><input type="email" aria-label={t('invitesPage.emailOptional')} placeholder={t('invitesPage.emailOptional')} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} /></div>
                  <div className="form-group"><input aria-label={t('storefrontPage.phoneOptional')} placeholder={t('storefrontPage.phoneOptional')} value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} inputMode="tel" /></div>
                </>
              )}
              {payOptions.length === 0 ? (
                <div className="alert warning">{t('storefrontPage.notTakingOrders')}</div>
              ) : (
                <fieldset className="pay-choice">
                  <legend>{t('storefrontPage.howToPay')}</legend>
                  {['online', ...(canTransfer ? ['transfer'] : []), 'cash', 'credit'].map((o) => {
                    const ok = payOptions.includes(o);
                    const why = o === 'online' ? t('storefrontPage.onlineOff')
                      : o === 'cash' ? t('storefrontPage.cashOff')
                        : !customer ? t('storefrontPage.creditLogin')
                          : credit.account?.status === 'pending' ? t('storefrontPage.creditAwaiting')
                            : credit.guarantors.length ? t('storefrontPage.creditApplyBelow') : t('storefrontPage.creditOff');
                    return (
                      <label key={o} style={ok ? undefined : { opacity: 0.55 }}>
                        <input type="radio" name="pay" disabled={!ok} checked={ok && payChoice === o} onChange={() => setPayMethod(o)} />{' '}
                        {o === 'credit' && !ok ? `🤝 ${t('storefrontPage.payOnCredit')}` : payLabel(o)}
                        {!ok && <span className="muted" style={{ display: 'block', fontSize: 11, marginLeft: 24 }}>{why}</span>}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {credit.guarantors.length > 0 && !creditOk && (
                customer
                  ? (credit.account?.status === 'pending'
                    ? <><p className="muted" style={{ fontSize: 12 }}>⏳ {t('storefrontPage.creditPending', { guarantor: credit.account.guarantor_name })}</p>
                      <CreditKycSteps storeId={storeId} token={customer.token} credit={credit} formatMoney={formatCurrency} onChange={loadCredit} /></>
                    : !applyForm && <button type="button" className="btn small secondary" onClick={() => setApplyForm({ guarantorId: credit.guarantors[0].id, memberRef: '', requestedLimit: '' })}>🤝 {t('storefrontPage.applyCredit')}</button>)
                  : <p className="muted" style={{ fontSize: 12 }}>🤝 {t('storefrontPage.creditLogin')}</p>
              )}
              {applyForm && (
                <form onSubmit={submitCredit} className="card mt-1" style={{ padding: 12 }}>
                  <p className="muted" style={{ fontSize: 12 }}>{t('storefrontPage.creditExplain')}</p>
                  <div className="form-group"><label htmlFor="cr-g">{t('storefrontPage.guarantor')}</label>
                    <select id="cr-g" value={applyForm.guarantorId} onChange={(e) => setApplyForm({ ...applyForm, guarantorId: e.target.value })}>
                      {credit.guarantors.map((g) => <option key={g.id} value={g.id}>{g.name} ({t(`storefrontPage.gKind_${g.kind}`)})</option>)}
                    </select></div>
                  <div className="form-group"><label htmlFor="cr-ref">{t('storefrontPage.memberRef')}</label><input id="cr-ref" value={applyForm.memberRef} onChange={(e) => setApplyForm({ ...applyForm, memberRef: e.target.value })} required /></div>
                  <div className="form-group"><label htmlFor="cr-amt">{t('storefrontPage.creditAmount')}</label><input id="cr-amt" type="number" min="1" value={applyForm.requestedLimit} onChange={(e) => setApplyForm({ ...applyForm, requestedLimit: e.target.value })} required /></div>
                  <div className="flex"><button className="btn small" type="submit">{t('storefrontPage.sendApplication')}</button><button type="button" className="btn small secondary" onClick={() => setApplyForm(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div>
                </form>
              )}
              {method === 'online' && <p className="muted" style={{ fontSize: 12 }}>🔒 {t('storefrontPage.securePayNote', { store: store?.name || '' })}</p>}
              <div className="flex">
                <button className="btn" disabled={payOptions.length === 0} onClick={placeOrder}>{method === 'online' ? t('storefrontPage.payNow', { amount: formatCurrency(cartTotal) }) : t('storefrontPage.placeOrder')}</button>
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
      {cartCount > 0 && (
        <a className="sf-cartbar" href="#sf-cart">
          🛒 {t('storefrontPage.viewCart', { count: cartCount })} · <strong>{formatCurrency(cartTotal)}</strong>
        </a>
      )}
      <BrandFooter />
    </div>
  );
}

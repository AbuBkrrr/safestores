import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { LanguageSwitcher } from '../components/Layout.jsx';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const client = axios.create({ baseURL: API_BASE });

// The unified, cross-store marketplace — distinct from Storefront.jsx
// (one specific store's own shop link). This is the "browse everything,
// pick a store" entry point: search/filter across every store that's
// opted into the marketplace (see Super Admin's per-store toggle),
// checkout works without an account, and a cart spanning multiple stores
// is split into one order per store at checkout time, since each store's
// own inventory/order system only knows about its own stock.
export default function MarketplaceHome() {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [stores, setStores] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [storeId, setStoreId] = useState('');
  const [cart, setCart] = useState({}); // productId -> quantity
  const [showCart, setShowCart] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [guestForm, setGuestForm] = useState({ name: '', email: '', phone: '', address: '' });
  const [message, setMessage] = useState('');
  const [placing, setPlacing] = useState(false);
  const [confirmation, setConfirmation] = useState(null);

  useEffect(() => {
    client.get('/marketplace/stores').then((r) => setStores(r.data)).catch(() => {});
  }, []);

  const runSearch = () => {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (category) params.category = category;
    if (storeId) params.storeId = storeId;
    client.get('/marketplace/search-products', { params })
      .then((r) => setProducts(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => { runSearch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];

  const addToCart = (productId) => setCart((c) => ({ ...c, [productId]: (c[productId] || 0) + 1 }));
  const changeQty = (productId, delta) => setCart((c) => {
    const next = { ...c };
    const qty = (next[productId] || 0) + delta;
    if (qty <= 0) delete next[productId]; else next[productId] = qty;
    return next;
  });

  const cartItems = Object.entries(cart).map(([productId, quantity]) => {
    const product = products.find((p) => p.id === productId);
    return product ? { ...product, quantity } : null;
  }).filter(Boolean);
  const cartTotal = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const cartCount = cartItems.reduce((sum, i) => sum + i.quantity, 0);

  // A cart can span stores — split into one order per store, since each
  // store's inventory/order system is independent (see the desktop-only
  // architecture: this cloud service is a relay to whichever store the
  // items belong to, not a single combined checkout).
  const placeOrder = async () => {
    if (!guestForm.name || !guestForm.address) {
      setMessage(t('marketplaceHomePage.nameAddressRequired'));
      return;
    }
    setPlacing(true);
    setMessage('');
    const byStore = cartItems.reduce((acc, item) => {
      (acc[item.store_id] ||= []).push(item);
      return acc;
    }, {});

    try {
      const placedOrders = [];
      for (const [sId, items] of Object.entries(byStore)) {
        const { data } = await client.post(`/marketplace/${sId}/orders`, {
          items: items.map((i) => ({ productId: i.id, quantity: i.quantity })),
          deliveryAddress: guestForm.address,
          guestName: guestForm.name,
          guestEmail: guestForm.email || undefined,
          guestPhone: guestForm.phone || undefined,
        });
        placedOrders.push({ storeName: items[0].store_name, order: data });
      }
      setCart({});
      setCheckoutOpen(false);
      setShowCart(false);
      setConfirmation(placedOrders);
      runSearch();
    } catch (err) {
      setMessage(err.response?.data?.error || t('marketplaceHomePage.orderFailed'));
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <div className="flex-between mt-1" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0 }}>{t('marketplaceHomePage.title')}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>{t('marketplaceHomePage.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 140 }}><LanguageSwitcher /></div>
          <button className="btn secondary" onClick={() => setShowCart((s) => !s)}>
            🛒 {t('marketplaceHomePage.cart')} {cartCount > 0 && <span className="badge active">{cartCount}</span>}
          </button>
        </div>
      </div>

      {confirmation && (
        <div className="alert success">
          <strong>{t('marketplaceHomePage.orderPlaced', { plural: confirmation.length > 1 ? 's' : '' })}</strong>{' '}
          {confirmation.map((c, i) => (
            <span key={c.order.id}>{i > 0 ? ', ' : ''}#{c.order.id.slice(0, 8)} ({c.storeName})</span>
          ))}
          <button className="btn small secondary mt-1" onClick={() => setConfirmation(null)} style={{ display: 'block' }}>
            {t('marketplaceHomePage.continueShopping')}
          </button>
        </div>
      )}

      {/* Search + filters */}
      <div className="card">
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          <input
            placeholder={t('marketplaceHomePage.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            style={{ flex: 2, minWidth: 200 }}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: 1, minWidth: 140 }}>
            <option value="">{t('marketplaceHomePage.allCategories')}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
            <option value="">{t('marketplaceHomePage.allStores')}</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.city ? ` — ${s.city}` : ''}</option>)}
          </select>
          <button className="btn" onClick={runSearch}>{t('marketplaceHomePage.search')}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, marginTop: 20 }}>
        {/* Product grid */}
        <div style={{ flex: 1 }}>
          {loading && <p className="muted">{t('marketplaceHomePage.loadingProducts')}</p>}
          {!loading && products.length === 0 && <div className="empty-state">{t('marketplaceHomePage.noProductsMatch')}</div>}
          <div className="grid grid-4">
            {products.map((p) => (
              <div key={p.id} className="card" style={{ padding: 12 }}>
                <div style={{
                  height: 110, borderRadius: 8, marginBottom: 8, overflow: 'hidden',
                  background: 'var(--primary-light)', display: 'grid', placeItems: 'center', fontSize: 36,
                }}>
                  {p.image_url ? <img src={p.image_url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : categoryPlaceholder(p.category)}
                </div>
                <strong style={{ fontSize: 14 }}>{p.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{p.store_name}{p.brand ? ` · ${p.brand}` : ''}</div>
                <div style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 4 }}>{formatCurrency(p.price)}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{p.in_stock ? t('marketplaceHomePage.inStock') : t('marketplaceHomePage.outOfStock')}</div>
                <button
                  className="btn small mt-1"
                  style={{ width: '100%' }}
                  disabled={!p.in_stock}
                  onClick={() => addToCart(p.id)}
                >
                  {cart[p.id] ? t('marketplaceHomePage.inCart', { count: cart[p.id] }) : t('marketplaceHomePage.addToCart')}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Cart sidebar */}
        {showCart && (
          <div className="card" style={{ width: 300, flexShrink: 0, alignSelf: 'flex-start', position: 'sticky', top: 20 }}>
            <h3>{t('marketplaceHomePage.yourCart')}</h3>
            {cartItems.length === 0 && <p className="muted">{t('marketplaceHomePage.cartEmpty')}</p>}
            {cartItems.map((item) => (
              <div key={item.id} className="flex-between mt-1" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{item.store_name}</div>
                </div>
                <div className="flex" style={{ gap: 4 }}>
                  <button className="btn small secondary" onClick={() => changeQty(item.id, -1)}>−</button>
                  <span>{item.quantity}</span>
                  <button className="btn small secondary" onClick={() => changeQty(item.id, 1)}>+</button>
                </div>
              </div>
            ))}
            {cartItems.length > 0 && (
              <>
                <div className="flex-between mt-1" style={{ fontWeight: 700, fontSize: 16 }}>
                  <span>{t('marketplaceHomePage.total')}</span><span>{formatCurrency(cartTotal)}</span>
                </div>
                <button className="btn mt-1" style={{ width: '100%' }} onClick={() => setCheckoutOpen(true)}>
                  {t('marketplaceHomePage.proceedToCheckout')}
                </button>
                <p className="muted" style={{ fontSize: 11, textAlign: 'center', marginTop: 6 }}>
                  {t('marketplaceHomePage.guestCheckoutNote')}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Checkout modal */}
      {checkoutOpen && (
        <div className="modal-overlay">
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <h2>{t('marketplaceHomePage.checkout')}</h2>
            <div className="alert info">
              {Object.entries(cartItems.reduce((acc, i) => { (acc[i.store_name] ||= 0); acc[i.store_name] += i.price * i.quantity; return acc; }, {}))
                .map(([name, total]) => <div key={name}>{name}: {formatCurrency(total)}</div>)}
              <strong>{t('marketplaceHomePage.total')}: {formatCurrency(cartTotal)}</strong>
            </div>
            <div className="alert error" style={{ display: message ? 'block' : 'none' }}>{message}</div>
            <div className="form-group">
              <label>{t('marketplaceHomePage.fullName')}</label>
              <input value={guestForm.name} onChange={(e) => setGuestForm({ ...guestForm, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('marketplaceHomePage.emailOptional')}</label>
              <input type="email" value={guestForm.email} onChange={(e) => setGuestForm({ ...guestForm, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('marketplaceHomePage.phone')}</label>
              <input value={guestForm.phone} onChange={(e) => setGuestForm({ ...guestForm, phone: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('marketplaceHomePage.deliveryAddress')}</label>
              <input value={guestForm.address} onChange={(e) => setGuestForm({ ...guestForm, address: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setCheckoutOpen(false)}>{t('marketplaceHomePage.backToCart')}</button>
              <button className="btn" onClick={placeOrder} disabled={placing}>{placing ? t('marketplaceHomePage.placing') : t('marketplaceHomePage.placeOrder')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// No captured photo for this product — a plain category-based emoji
// placeholder rather than a broken image or empty box.
function categoryPlaceholder(category) {
  const map = {
    groceries: '🛒', dairy: '🥛', bakery: '🍞', meat: '🍖', fruit: '🍎',
    household: '🧹', electronics: '💻', pharmacy: '💊',
  };
  return map[(category || '').toLowerCase()] || '📦';
}

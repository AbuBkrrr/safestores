import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import client from '../api/client.js';
import { formatCurrency as format } from '../utils/currency.js';
import { shopper } from '../utils/shopperLocal.js';
import AskShopDialog from '../components/AskShopDialog.jsx';
import InstallMarketBanner from '../components/InstallMarketBanner.jsx';

// The shopper app: every shop on SAFE Stores in one place — deals, newest
// stock, what's popular, the cheapest shop for an item, favourites, a
// shopping list, buy-again, orders and messages to shops. No account needed;
// checkout happens in the shop's own page (all payment options there).

const TABS = ['home', 'search', 'stores', 'saved', 'orders', 'messages'];

function useShopperData() {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    window.addEventListener('ss-shopper', f);
    return () => window.removeEventListener('ss-shopper', f);
  }, []);
  return shopper;
}

function Item({ p, money, onAsk }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const s = useShopperData();
  const fav = s.isFav('items', p.id);
  const open = () => navigate(`/shop/${p.shop_slug || p.store_id || p.storeId}?add=${p.id}`);
  return (
    <div className={`product-tile${p.in_stock === false ? ' out' : ''}`} style={{ flex: '0 0 165px', width: 165 }}>
      {p.image_url ? <img src={p.image_url} alt="" loading="lazy" /> : <div className="pt-ph" aria-hidden="true">{p.name.trim().charAt(0).toUpperCase()}</div>}
      <div className="pt-name">{p.name}</div>
      <div className="muted pt-cat">{p.store_name || p.storeName}{p.store_city ? ` · ${p.store_city}` : ''}</div>
      <div className="pt-foot" style={{ flexWrap: 'wrap', gap: 4 }}>
        <strong>
          {p.on_sale && <span className="badge active" style={{ marginRight: 4 }}>{p.pct_off ? `-${p.pct_off}%` : (p.promo_label || t('shopper.sale'))}</span>}
          {money(p.price)}
          {p.on_sale && <s className="muted" style={{ fontWeight: 400, marginLeft: 4, fontSize: 12 }}>{money(p.regular_price)}</s>}
        </strong>
      </div>
      <div className="flex" style={{ gap: 6, marginTop: 6 }}>
        {p.in_stock === false ? <span className="muted small">{t('storefrontPage.outOfStockTag')}</span>
          : <button type="button" className="btn small" onClick={open}>{t('shopper.buy')}</button>}
        <button type="button" className="btn secondary small" aria-label={t('shopper.save')} onClick={() => s.toggleFav('items', { id: p.id, name: p.name, price: p.price, image_url: p.image_url, store_id: p.store_id || p.storeId, store_name: p.store_name || p.storeName, shop_slug: p.shop_slug })}>{fav ? '❤️' : '🤍'}</button>
        {onAsk && <button type="button" className="btn secondary small" aria-label={t('shopper.ask')} onClick={() => onAsk(p)}>💬</button>}
      </div>
    </div>
  );
}

function Row({ title, items, money, onAsk, empty }) {
  if (!items?.length) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <section className="mt-1">
      <h3 style={{ margin: '12px 0 8px' }}>{title}</h3>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
        {items.map((p) => <Item key={`${p.id}-${p.store_id || ''}`} p={p} money={money} onAsk={onAsk} />)}
      </div>
    </section>
  );
}

export default function ShopperApp() {
  const { t } = useTranslation();
  const s = useShopperData();
  const [tab, setTab] = useState(() => { const x = new URLSearchParams(window.location.search).get('tab'); return TABS.includes(x) ? x : 'home'; });
  const [city, setCity] = useState(() => s.profile().city || '');
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [ask, setAsk] = useState(null); // { store, product, kind }
  const [threads, setThreads] = useState({});
  const [listText, setListText] = useState('');
  const [currency, setCurrency] = useState({});
  const money = (n) => format(n, currency);

  useEffect(() => { client.get('/settings/currency').then((r) => setCurrency(r.data)).catch(() => {}); }, []);
  useEffect(() => {
    client.get('/marketplace/discover', { params: city ? { city } : {} })
      .then((r) => { const d = r.data && typeof r.data === 'object' ? r.data : {}; const arr = (x) => (Array.isArray(x) ? x : []); setData({ deals: arr(d.deals), newest: arr(d.newest), popular: arr(d.popular), stores: arr(d.stores) }); })
      .catch(() => setData({ deals: [], newest: [], popular: [], stores: [] }));
  }, [city]);
  useEffect(() => {
    if (tab !== 'messages') return;
    s.messages().forEach((m) => client.get(`/marketplace/inquiries/${m.token}`).then((r) => setThreads((x) => ({ ...x, [m.token]: r.data }))).catch(() => {}));
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (e) => {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setTab('search');
    const r = await client.get('/marketplace/compare', { params: { q: q.trim(), ...(city ? { city } : {}) } }).catch(() => ({ data: [] }));
    setResults(r.data);
  };
  const storeById = useMemo(() => new Map((data?.stores || []).map((st) => [st.id, st])), [data]);
  const askAbout = (p) => setAsk({ store: { id: p.store_id || p.storeId, name: p.store_name || p.storeName, phone: storeById.get(p.store_id)?.phone }, product: p, kind: 'question' });
  const cities = [...new Set((data?.stores || []).map((st) => st.city).filter(Boolean))].sort();
  const favStores = Object.values(s.all().stores || {});
  const favItems = Object.values(s.all().items || {});
  const unread = s.messages().filter((m) => threads[m.token]?.status === 'answered').length;

  return (
    <div className="shopper-app" style={{ maxWidth: 1100, margin: '0 auto', padding: '12px 14px 80px' }}>
      <header className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🛍️ {t('shopper.title')}</h1>
        <select aria-label={t('shopper.city')} value={city} onChange={(e) => { setCity(e.target.value); s.saveProfile({ city: e.target.value }); }} style={{ width: 'auto' }}>
          <option value="">📍 {t('shopper.allCities')}</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </header>

      <form onSubmit={search} className="flex mt-1" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('shopper.searchPh')} aria-label={t('shopper.searchPh')} style={{ flex: 1 }} />
        <button className="btn">🔍</button>
      </form>

      <nav className="flex mt-1" style={{ gap: 6, overflowX: 'auto', flexWrap: 'nowrap' }} aria-label={t('shopper.title')}>
        {TABS.map((k) => (
          <button key={k} type="button" className={`btn small ${tab === k ? '' : 'secondary'}`} style={{ whiteSpace: 'nowrap', flex: '0 0 auto' }} onClick={() => setTab(k)}>
            {t(`shopper.tab_${k}`)}{k === 'messages' && unread ? ` (${unread})` : ''}{k === 'orders' && s.orders().length ? ` (${s.orders().length})` : ''}
          </button>
        ))}
      </nav>

      {tab === 'home' && (
        <>
          {!data && <p className="muted">{t('common.loading', 'Loading…')}</p>}
          <Row title={`🔥 ${t('shopper.deals')}`} items={data?.deals} money={money} onAsk={askAbout} />
          <Row title={`🔁 ${t('shopper.buyAgain')}`} items={s.buyAgain()} money={money} />
          {s.frequentStores().length > 0 && (
            <section className="mt-1">
              <h3 style={{ margin: '12px 0 8px' }}>⭐ {t('shopper.yourShops')}</h3>
              <div className="flex" style={{ gap: 8, overflowX: 'auto', flexWrap: 'nowrap' }}>
                {s.frequentStores().map((st) => <Link key={st.id} className="btn secondary small" style={{ whiteSpace: 'nowrap' }} to={`/shop/${st.slug || st.id}`}>{st.name}</Link>)}
              </div>
            </section>
          )}
          <Row title={`🆕 ${t('shopper.newest')}`} items={data?.newest} money={money} onAsk={askAbout} />
          <Row title={`📈 ${t('shopper.popular')}`} items={data?.popular} money={money} onAsk={askAbout} />
          {data && !data.deals.length && !data.newest.length && !data.popular.length && <p className="muted mt-1">{t('shopper.nothingYet')}</p>}
        </>
      )}

      {tab === 'search' && (
        <section className="mt-1">
          {!results && <p className="muted">{t('shopper.searchHint')}</p>}
          {results && results.length === 0 && (
            <p className="muted">{t('shopper.noResults')} <button type="button" className="link-btn" onClick={() => setTab('stores')}>{t('shopper.requestFromShop')}</button></p>
          )}
          {results?.map((g) => (
            <div key={g.name} className="card mt-1">
              <div className="flex" style={{ gap: 10, alignItems: 'center', flexWrap: 'nowrap' }}>
                {g.image_url && <img src={g.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{g.name}</strong>
                  <div className="small">{t('shopper.cheapestAt', { price: money(g.cheapest.price), store: g.cheapest.store_name })}{g.stores > 1 ? ` · ${t('shopper.ofStores', { n: g.stores })}` : ''}</div>
                </div>
              </div>
              <table className="table mt-1">
                <tbody>
                  {g.offers.map((o, i) => (
                    <tr key={o.id}>
                      <td>{i === 0 && o.in_stock && g.stores > 1 && <span className="badge active">{t('shopper.cheapest')}</span>} {o.store_name}<div className="muted small">{o.store_city}</div></td>
                      <td><strong>{money(o.price)}</strong>{o.on_sale && <div className="small"><s className="muted">{money(o.regular_price)}</s> {o.promo_label}</div>}</td>
                      <td style={{ textAlign: 'right' }}>
                        {o.in_stock ? <Link className="btn small" to={`/shop/${o.shop_slug || o.store_id}?add=${o.id}`}>{t('shopper.buy')}</Link> : <span className="muted small">{t('storefrontPage.outOfStockTag')}</span>}
                        {' '}<button type="button" className="btn secondary small" onClick={() => askAbout(o)} aria-label={t('shopper.ask')}>💬</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {tab === 'stores' && (
        <section className="mt-1">
          {(data?.stores || []).map((st) => (
            <div key={st.id} className="card mt-1 flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <strong>{st.name}</strong> {s.isFav('stores', st.id) && '⭐'}
                <div className="muted small">{[st.category, st.city].filter(Boolean).join(' · ')} · {t('shopper.itemsCount', { n: st.items })}{st.deals ? ` · 🔥 ${t('shopper.dealsCount', { n: st.deals })}` : ''}</div>
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <Link className="btn small" to={`/shop/${st.shop_slug || st.id}`}>{t('shopper.visit')}</Link>
                <button type="button" className="btn secondary small" onClick={() => s.toggleFav('stores', { id: st.id, name: st.name, slug: st.shop_slug, city: st.city })} aria-label={t('shopper.save')}>{s.isFav('stores', st.id) ? '⭐' : '☆'}</button>
                <button type="button" className="btn secondary small" onClick={() => setAsk({ store: st, kind: 'request' })}>🙋 {t('shopper.request')}</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {tab === 'saved' && (
        <section className="mt-1">
          <div className="card">
            <h3>📝 {t('shopper.shoppingList')}</h3>
            <form className="flex" style={{ gap: 8, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (listText.trim()) { s.addToList(listText.trim()); setListText(''); } }}>
              <input value={listText} onChange={(e) => setListText(e.target.value)} placeholder={t('shopper.listPh')} aria-label={t('shopper.listPh')} style={{ flex: 1 }} />
              <button className="btn small">＋</button>
            </form>
            {s.list().map((x) => (
              <div key={x.id} className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', flexWrap: 'nowrap' }}>
                <label className="flex" style={{ gap: 8 }}><input type="checkbox" checked={x.done} onChange={() => s.toggleList(x.id)} /> <span style={{ textDecoration: x.done ? 'line-through' : 'none' }}>{x.text}</span></label>
                <span className="flex" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  <button type="button" className="btn secondary small" onClick={() => { setQ(x.text); setTimeout(() => document.querySelector('.shopper-app form button.btn')?.click(), 0); }}>{t('shopper.findCheapest')}</button>
                  <button type="button" className="btn secondary small" aria-label={t('common.remove', 'Remove')} onClick={() => s.removeFromList(x.id)}>✕</button>
                </span>
              </div>
            ))}
          </div>
          <Row title={`❤️ ${t('shopper.savedItems')}`} items={favItems} money={money} empty={t('shopper.savedEmpty')} />
          {favStores.length > 0 && (
            <section className="mt-1">
              <h3>⭐ {t('shopper.savedShops')}</h3>
              <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                {favStores.map((st) => <Link key={st.id} className="btn secondary small" to={`/shop/${st.slug || st.id}`}>{st.name}</Link>)}
              </div>
            </section>
          )}
        </section>
      )}

      {tab === 'orders' && (
        <section className="mt-1">
          {s.orders().length === 0 && <p className="muted">{t('shopper.noOrders')}</p>}
          {s.orders().map((o) => (
            <div key={o.token} className="card mt-1 flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <strong>{o.storeName}</strong> · {money(o.total)}
                <div className="muted small">{new Date(o.at).toLocaleString()} · {(o.items || []).map((i) => i.name).join(', ').slice(0, 80)}</div>
              </div>
              <span className="flex" style={{ gap: 6 }}>
                <Link className="btn small" to={`/track/${o.token}`}>{t('shopper.track')}</Link>
                {(o.items || [])[0] && <Link className="btn secondary small" to={`/shop/${o.storeId}?add=${o.items[0].id}`}>{t('shopper.reorder')}</Link>}
              </span>
            </div>
          ))}
        </section>
      )}

      {tab === 'messages' && (
        <section className="mt-1">
          {s.messages().length === 0 && <p className="muted">{t('shopper.noMessages')}</p>}
          {s.messages().map((m) => {
            const th = threads[m.token];
            return (
              <div key={m.token} className="card mt-1">
                <div className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <strong>{m.kind === 'request' ? '🙋' : '💬'} {m.storeName}{m.product ? ` · ${m.product}` : ''}</strong>
                  <span className={`badge ${th?.status === 'answered' ? 'active' : 'pending'}`}>{th ? t(`shopper.status_${th.status}`) : '…'}</span>
                </div>
                {(th?.messages || [{ from_store: false, body: m.text, created_at: m.at }]).map((x, i) => (
                  <div key={i} style={{ margin: '6px 0', textAlign: x.from_store ? 'left' : 'right' }}>
                    <span style={{ display: 'inline-block', padding: '6px 10px', borderRadius: 10, background: x.from_store ? 'var(--border, #e5e7eb)' : 'var(--primary, #0f766e)', color: x.from_store ? 'inherit' : '#fff', maxWidth: '85%' }}>{x.body}</span>
                  </div>
                ))}
                {th && (
                  <form className="flex" style={{ gap: 6, flexWrap: 'nowrap' }} onSubmit={async (e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.reply;
                    if (!input.value.trim()) return;
                    await client.post(`/marketplace/inquiries/${m.token}/reply`, { message: input.value.trim() });
                    input.value = '';
                    const r = await client.get(`/marketplace/inquiries/${m.token}`); setThreads((x) => ({ ...x, [m.token]: r.data }));
                  }}>
                    <input name="reply" placeholder={t('shopper.replyPh')} aria-label={t('shopper.replyPh')} style={{ flex: 1 }} />
                    <button className="btn small">{t('shopper.send')}</button>
                  </form>
                )}
              </div>
            );
          })}
        </section>
      )}

      <InstallMarketBanner />
      {ask && ask.store?.id && <AskShopDialog store={ask.store} product={ask.product} kind={ask.kind} onClose={() => setAsk(null)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { EmptyState, Metric } from '../components/ui.jsx';

const TABS = ['profit', 'abc', 'deadStock', 'forecast', 'heatmap'];
const DAYS = [7, 30, 90, 365];

/** Profit & margin, ABC, dead stock, forecast and busiest hours. */
export default function Insights() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency: f } = useCurrency();
  const [tab, setTab] = useState('profit');
  const [days, setDays] = useState(30);
  // Data is tagged with the tab+period it was fetched for: switching tabs
  // re-renders before the new request finishes, and a slow earlier
  // response must never be drawn with another tab's layout.
  const [loaded, setLoaded] = useState({ key: null, data: null });
  const key = `${tab}:${days}`;
  const data = loaded.key === key ? loaded.data : null;

  useEffect(() => {
    let live = true;
    const path = { profit: 'profit', abc: 'abc', deadStock: 'dead-stock', forecast: 'forecast', heatmap: 'heatmap' }[tab];
    const params = tab === 'deadStock' ? { days: Math.max(days, 30) } : { days };
    api.get(`/stores/${user.storeId}/insights/${path}`, { params })
      .then((r) => { if (live) setLoaded({ key, data: r.data }); })
      .catch(() => { if (live) setLoaded({ key, data: { error: true } }); });
    return () => { live = false; };
  }, [key, user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekdays = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' }));
  const maxCell = data?.grid ? Math.max(1, ...data.grid.flat()) : 1;

  return (
    <div>
      <div className="topbar">
        <div><h1>{t('insightsPage.title')}</h1><p className="muted">{t('insightsPage.subtitle')}</p></div>
        <select aria-label={t('insightsPage.period')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {DAYS.map((d) => <option key={d} value={d}>{t('insightsPage.lastDays', { count: d })}</option>)}
        </select>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((k) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{t(`insightsPage.tabs.${k}`)}</button>)}
      </div>

      {!data ? <p className="muted">{t('common.loading')}</p> : data.error ? <EmptyState>{t('common.errorGeneric')}</EmptyState> : (
        <>
          {tab === 'profit' && (
            <>
              <div className="grid grid-4">
                <Metric value={f(data.revenue)} label={t('insightsPage.revenue')} />
                <Metric value={f(data.cost)} label={t('insightsPage.cost')} />
                <Metric value={f(data.profit)} label={t('insightsPage.grossProfit')} />
                <Metric value={`${data.marginPct}%`} label={t('insightsPage.margin')} />
              </div>
              <p className="muted">{t('insightsPage.profitNote')}</p>
              {data.products.length === 0 ? <EmptyState>{t('insightsPage.noSales')}</EmptyState> : (
                <div className="card table-wrap">
                  <table>
                    <thead><tr><th>{t('products.name')}</th><th>{t('insightsPage.units')}</th><th>{t('insightsPage.revenue')}</th><th>{t('insightsPage.grossProfit')}</th><th>{t('insightsPage.margin')}</th></tr></thead>
                    <tbody>{data.products.map((p) => (
                      <tr key={p.productId}><td>{p.name}</td><td>{p.units}</td><td>{f(p.revenue)}</td><td style={{ color: p.profit < 0 ? 'var(--danger)' : undefined }}>{f(p.profit)}</td><td>{p.marginPct}%</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'abc' && (
            <>
              <div className="grid grid-4">
                {data.summary.map((s) => <Metric key={s.class} value={`${s.items} · ${f(s.revenue)}`} label={t(`insightsPage.class${s.class}`)} />)}
              </div>
              <p className="muted">{t('insightsPage.abcNote')}</p>
              <div className="card table-wrap">
                <table>
                  <thead><tr><th>{t('insightsPage.class')}</th><th>{t('products.name')}</th><th>{t('insightsPage.revenue')}</th><th>{t('insightsPage.share')}</th></tr></thead>
                  <tbody>{data.products.map((p) => (
                    <tr key={p.productId}><td><span className={`badge ${p.class === 'A' ? 'active' : p.class === 'B' ? 'pending' : 'closed'}`}>{p.class}</span></td><td>{p.name}</td><td>{f(p.revenue)}</td><td>{p.sharePct}%</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'deadStock' && (
            <>
              <div className="grid grid-4">
                <Metric value={data.products.length} label={t('insightsPage.idleItems', { days: data.days })} />
                <Metric value={f(data.totalValue)} label={t('insightsPage.cashTiedUp')} />
              </div>
              <p className="muted">{t('insightsPage.deadNote')}</p>
              {data.products.length === 0 ? <EmptyState>{t('insightsPage.noDead')}</EmptyState> : (
                <div className="card table-wrap">
                  <table>
                    <thead><tr><th>{t('products.name')}</th><th>{t('insightsPage.onHand')}</th><th>{t('insightsPage.daysIdle')}</th><th>{t('insightsPage.valueAtCost')}</th></tr></thead>
                    <tbody>{data.products.map((p) => <tr key={p.productId}><td>{p.name}</td><td>{p.onHand}</td><td>{p.daysIdle}</td><td>{f(p.valueAtCost)}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'forecast' && (
            <>
              <p className="muted">{t('insightsPage.forecastNote', { days })}</p>
              <div className="card table-wrap">
                <table>
                  <thead><tr><th>{t('products.name')}</th><th>{t('insightsPage.avgDaily')}</th><th>{t('insightsPage.next30')}</th><th>{t('insightsPage.onHand')}</th><th>{t('insightsPage.daysCover')}</th><th>{t('insightsPage.suggested')}</th></tr></thead>
                  <tbody>{data.products.map((p) => (
                    <tr key={p.productId} style={p.reorderNow ? { background: 'rgba(179,58,58,0.06)' } : undefined}>
                      <td>{p.name}{p.reorderNow && <span className="badge overdue" style={{ marginLeft: 6 }}>{t('insightsPage.reorderNow')}</span>}</td>
                      <td>{p.avgDaily}</td><td>{p.next30Days}</td><td>{p.onHand}</td><td>{p.daysOfCover ?? '—'}</td><td>{p.suggestedQty || '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'heatmap' && (
            <div className="card table-wrap">
              <p className="muted">{t('insightsPage.heatmapNote', { tz: data.timeZone })}</p>
              <table className="heatmap" aria-label={t('insightsPage.tabs.heatmap')}>
                <thead><tr><th></th>{[...Array(24)].map((_, h) => <th key={h} style={{ fontSize: 10, padding: 2 }}>{h}</th>)}</tr></thead>
                <tbody>{data.grid.map((row, d) => (
                  <tr key={d}><th style={{ fontSize: 12 }}>{weekdays[d]}</th>{row.map((v, h) => (
                    <td key={h} title={`${weekdays[d]} ${h}:00 — ${f(v)}`} style={{ padding: 0, width: 22, height: 22, background: v ? `rgba(15,113,128,${0.12 + 0.88 * (v / maxCell)})` : 'transparent', border: '1px solid var(--line)' }} />
                  ))}</tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

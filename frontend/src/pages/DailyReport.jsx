import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { EmptyState, Metric } from '../components/ui.jsx';
import { methodLabel } from '../utils/receipt.js';

/** End-of-day report for any date, in the store's own time zone. */
export default function DailyReport() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency: f } = useCurrency();
  const [date, setDate] = useState('');
  const [r, setR] = useState(null);

  const load = (d) => api.get(`/stores/${user.storeId}/reports/daily`, { params: d ? { date: d } : {} }).then((res) => { setR(res.data); if (!d) setDate(res.data.date); });
  useEffect(() => { load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const maxHour = r ? Math.max(1, ...r.byHour.map((h) => h.total)) : 1;

  return (
    <div>
      <div className="topbar">
        <div><h1>{t('dailyPage.title')}</h1><p className="muted">{r ? t('dailyPage.subtitle', { tz: r.timezone }) : ''}</p></div>
        <div className="flex">
          <input type="date" aria-label={t('dailyPage.date')} value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} />
          <button className="btn small secondary" onClick={() => window.print()}>{t('checkout.print')}</button>
        </div>
      </div>
      {!r ? <p className="muted">{t('common.loading')}</p> : (
        <>
          <div className="grid grid-4">
            <Metric value={f(r.gross)} label={t('dailyPage.gross')} />
            <Metric value={r.orders} label={t('dailyPage.orders')} />
            <Metric value={f(r.average)} label={t('dailyPage.average')} />
            <Metric value={f(r.net)} label={t('dailyPage.net')} />
            <Metric value={f(r.refunds.total)} label={t('dailyPage.refunds', { count: r.refunds.count })} />
            <Metric value={f(r.discounts)} label={t('receipt.discount')} />
            <Metric value={f(r.tax)} label={t('receipt.tax')} />
          </div>
          {r.orders === 0 ? <EmptyState>{t('dailyPage.noSales')}</EmptyState> : (
            <div className="grid grid-2 mt-1">
              <div className="card">
                <h3>{t('shift.byMethod')}</h3>
                {r.byMethod.map((m) => <div key={m.method} className="flex-between"><span>{methodLabel(m.method)}</span><span>{f(m.total)}</span></div>)}
              </div>
              <div className="card">
                <h3>{t('dailyPage.byCashier')}</h3>
                {r.byCashier.map((c) => <div key={c.name} className="flex-between"><span>{c.name} <span className="muted">({c.orders})</span></span><span>{f(c.total)}</span></div>)}
              </div>
              <div className="card">
                <h3>{t('dailyPage.byHour')}</h3>
                {r.byHour.map((h) => (
                  <div key={h.hour} className="flex" style={{ gap: 8 }}>
                    <span className="muted" style={{ width: 44 }}>{String(h.hour).padStart(2, '0')}:00</span>
                    <div role="img" aria-label={`${h.hour}:00 ${f(h.total)}`} style={{ height: 14, width: `${(h.total / maxHour) * 70}%`, background: 'var(--primary)', borderRadius: 3, minWidth: 2 }} />
                    <span style={{ fontSize: 12 }}>{f(h.total)}</span>
                  </div>
                ))}
              </div>
              <div className="card">
                <h3>{t('dailyPage.topItems')}</h3>
                {r.topItems.map((i) => <div key={i.name} className="flex-between"><span>{i.name} <span className="muted">× {i.units}</span></span><span>{f(i.total)}</span></div>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

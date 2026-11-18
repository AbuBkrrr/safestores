import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Metric } from './ui.jsx';

// Home screen for every role except admin/manager: only that role's own work.
export default function RoleDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [d, setD] = useState(null);
  useEffect(() => {
    const load = () => api.get(`/stores/${user.storeId}/my-dashboard`).then((r) => setD(r.data)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [user.storeId]);

  const when = (x) => (x ? new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const role = user.role === 'auditor' ? 'stock_taker' : user.role;
  const actions = {
    cashier: [['/checkout', `🛒 ${t('roleDash.startSale')}`], ['/sales', `🧮 ${t('roleDash.salesRefunds')}`], ['/shifts', `⏰ ${t('roleDash.myShift')}`]],
    checkout: [['/checkout', `🛒 ${t('roleDash.startSale')}`], ['/sales', `🧮 ${t('roleDash.salesRefunds')}`], ['/shifts', `⏰ ${t('roleDash.myShift')}`]],
    staff: [['/stock-arrival', `🚚 ${t('roleDash.receiveStock')}`], ['/movements', `🔁 ${t('roleDash.restockShelf')}`], ['/cycle-counting', `⏱️ ${t('roleDash.cycleCount')}`]],
    stock_taker: [['/shelf-audit', `📋 ${t('roleDash.countShelf')}`], ['/audit-report', `📑 ${t('roleDash.auditReport')}`]],
    marketplace_manager: [['/marketplace', `🛍️ ${t('roleDash.reviewOrders')}`]],
    security: [['/exit-check', `🛡️ ${t('roleDash.checkReceipt')}`]],
  }[role] || [];

  return (
    <div>
      <div className="topbar">
        <div className="page-title">
          <h1>{t(`roleDash.title_${role}`, { defaultValue: t('dashboard.title') })}</h1>
          <div className="sub">{t('dashboard.welcomeBack', { name: user.name })}</div>
        </div>
      </div>
      <div className="flex" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {actions.map(([to, label], i) => <Link key={to} to={to} className={`btn ${i ? 'secondary' : ''}`}>{label}</Link>)}
      </div>
      {!d ? <p className="muted">…</p> : (
        <>
          {['cashier', 'checkout'].includes(role) && (
            <>
              <div className="grid grid-4">
                <Metric value={d.salesToday?.count ?? 0} label={t('roleDash.mySalesToday')} />
                <Metric value={formatCurrency(d.salesToday?.total || 0)} label={t('roleDash.myTakingsToday')} />
                <Metric value={d.openShift ? `🟢 ${when(d.openShift.opened_at)}` : `⚪ ${t('roleDash.noShift')}`} label={t('roleDash.shift')} />
              </div>
              {d.parkedOrders > 0 && <div className="alert warning">⏸ {t('roleDash.parked', { count: d.parkedOrders })}</div>}
              <div className="card"><h3>{t('roleDash.myRecentSales')}</h3>
                {d.recentSales.length === 0 ? <p className="muted">{t('roleDash.noneYet')}</p> : (
                  <table><tbody>{d.recentSales.map((s) => <tr key={s.id}><td>{s.receipt_number}</td><td>{when(s.paid_at)}</td><td>{s.payment_method}</td><td style={{ textAlign: 'right' }}>{formatCurrency(s.total)}</td></tr>)}</tbody></table>
                )}
              </div>
            </>
          )}
          {role === 'staff' && (
            <>
              <div className="grid grid-2">
                <Metric value={d.shelfToRefill.length} label={t('roleDash.shelvesToRefill')} />
                <Metric value={d.countTasks ?? '—'} label={t('roleDash.countsDue')} />
              </div>
              <div className="card"><h3>{t('roleDash.refillThese')}</h3>
                {d.shelfToRefill.length === 0 ? <p className="muted">{t('roleDash.allStocked')}</p> : (
                  <table><thead><tr><th>{t('roleDash.product')}</th><th>{t('roleDash.onShelf')}</th><th>{t('roleDash.inBackroom')}</th></tr></thead>
                    <tbody>{d.shelfToRefill.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.shelf_qty}</td><td>{p.backroom_qty}</td></tr>)}</tbody></table>
                )}
              </div>
              <div className="card"><h3>{t('roleDash.myMoves')}</h3>
                {d.myMovements.length === 0 ? <p className="muted">{t('roleDash.noneYet')}</p> : (
                  <table><tbody>{d.myMovements.map((m, i) => <tr key={i}><td>{m.name}</td><td>{m.type.replace(/_/g, ' ')} × {m.quantity}</td><td>{when(m.created_at)}</td></tr>)}</tbody></table>
                )}
              </div>
            </>
          )}
          {role === 'stock_taker' && (
            <>
              <div className="grid grid-2">
                <Metric value={d.countsToday?.today ?? 0} label={t('roleDash.countedToday')} />
                <Metric value={d.countsToday?.mismatches ?? 0} label={t('roleDash.mismatches')} />
              </div>
              <div className="card"><h3>{t('roleDash.myCounts')}</h3>
                {d.recentCounts.length === 0 ? <p className="muted">{t('roleDash.noneYet')}</p> : (
                  <table><thead><tr><th>{t('roleDash.product')}</th><th>{t('roleDash.counted')}</th><th>{t('roleDash.difference')}</th><th></th></tr></thead>
                    <tbody>{d.recentCounts.map((c, i) => <tr key={i}><td>{c.name}</td><td>{c.counted_qty}</td><td style={{ color: c.discrepancy ? 'var(--danger)' : undefined }}>{c.discrepancy > 0 ? `+${c.discrepancy}` : c.discrepancy}</td><td>{when(c.created_at)}</td></tr>)}</tbody></table>
                )}
              </div>
            </>
          )}
          {role === 'marketplace_manager' && (
            <>
              <div className="grid grid-4">
                <Metric value={d.openOrders.placed || 0} label={t('roleDash.newOrders')} />
                <Metric value={d.openOrders.confirmed || 0} label={t('roleDash.toDispatch')} />
                <Metric value={(d.openOrders.out_for_delivery || 0) + (d.openOrders.ready_for_pickup || 0)} label={t('roleDash.onTheWay')} />
                <Metric value={d.fulfilledToday} label={t('roleDash.doneToday')} />
              </div>
              <div className="card"><h3>{t('roleDash.queue')}</h3>
                {d.queue.length === 0 ? <p className="muted">{t('roleDash.noOrders')}</p> : (
                  <table><tbody>{d.queue.map((o) => <tr key={o.id}><td>{o.customer_name}</td><td>{t(`marketplacePage.method_${o.fulfilment_method}`, { defaultValue: o.fulfilment_method || '—' })}</td><td>{o.status.replace(/_/g, ' ')}</td><td style={{ textAlign: 'right' }}>{formatCurrency(o.total)}</td></tr>)}</tbody></table>
                )}
              </div>
            </>
          )}
          {role === 'security' && (
            <>
              <div className="grid grid-2"><Metric value={d.checkedToday} label={t('roleDash.checkedToday')} /></div>
              <div className="card"><h3>{t('roleDash.lastChecks')}</h3>
                {d.recentChecks.length === 0 ? <p className="muted">{t('roleDash.noneYet')}</p> : (
                  <table><tbody>{d.recentChecks.map((c, i) => <tr key={i}><td>{c.receipt_number}</td><td>{when(c.exit_checked_at)}</td><td style={{ textAlign: 'right' }}>{formatCurrency(c.total)}</td></tr>)}</tbody></table>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

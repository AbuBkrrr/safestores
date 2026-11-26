import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { useStoreProfile } from '../utils/useStoreTier.js';
import { BUSINESS_TYPES } from '../utils/businessTypes.js';
import { Metric } from './ui.jsx';

// Shortcuts that fit each kind of business, most used first.
const ACTIONS = {
  general: ['checkout', 'receive', 'markup', 'labels'],
  butchery: ['checkout', 'breakdown', 'waste', 'receive'],
  abattoir: ['breakdown', 'checkout', 'waste', 'receive'],
  fresh_produce: ['checkout', 'waste', 'receive', 'markup'],
  ice_cream: ['produce', 'checkout', 'waste', 'receive'],
  bakery: ['produce', 'checkout', 'waste', 'receive'],
  restaurant: ['produce', 'checkout', 'waste', 'receive'],
  tailor: ['newJob', 'jobs', 'checkout', 'receive'],
  laundry: ['newJob', 'jobs', 'checkout', 'receive'],
  mechanic: ['newJob', 'jobs', 'checkout', 'receive'],
  tech_repair: ['newJob', 'jobs', 'checkout', 'receive'],
  engineering: ['newJob', 'jobs', 'checkout', 'receive'],
  building_materials: ['checkout', 'receive', 'markup', 'products'],
};
const ACTION = {
  checkout: ['🧾', '/checkout'], receive: ['📥', '/receipts'], markup: ['💹', '/products'], labels: ['🏷️', '/labels'],
  products: ['📦', '/products'], breakdown: ['🔪', '/production'], produce: ['🍳', '/production'], waste: ['🗑️', '/waste'],
  newJob: ['➕', '/jobs'], jobs: ['📋', '/jobs'], quickAdd: ['⚡', '/products?quick=1'], today: ['📅', '/daily-report'],
};

/** The top of the owner/manager dashboard, shaped by the business type chosen at sign-up. */
export default function BusinessPanel({ storeId }) {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const { businessType = 'general', tools = [], tier } = useStoreProfile();
  const type = BUSINESS_TYPES[businessType] ? businessType : 'general';
  const [jobs, setJobs] = useState(null);
  const [waste, setWaste] = useState(null);
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    if (tools.includes('jobs')) api.get(`/stores/${storeId}/jobs`).then((r) => setJobs(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    if (tools.includes('fresh')) api.get(`/stores/${storeId}/waste`, { params: { days: 7 } }).then((r) => setWaste(r.data)).catch(() => {});
    if (tools.includes('production') || tools.includes('breakdown')) {
      api.get(`/stores/${storeId}/production/runs`).then((r) => setRuns(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    }
  }, [storeId, tools.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date().toDateString();
  const endOfToday = new Date(new Date(today).getTime() + 86400000);
  const isToday = (d) => d && new Date(d).toDateString() === today;
  const soon = (d) => d && (new Date(d) - Date.now()) / 86400000 <= 2;

  const cards = [];
  if (jobs) {
    const open = jobs.filter((j) => !['collected', 'cancelled'].includes(j.status));
    cards.push(
      <Metric key="j1" value={open.filter((j) => j.status !== 'ready').length} label={t('bizDash.jobsInProgress')} />,
      <Metric key="j2" value={open.filter((j) => j.status === 'ready').length} label={t('bizDash.jobsReady')} />,
      <Metric key="j3" value={open.filter((j) => j.due_date && new Date(j.due_date) < endOfToday && j.status !== 'ready').length} label={t('bizDash.jobsDue')} />,
      <Metric key="j4" value={formatCurrency(open.reduce((s, j) => s + Math.max(0, Number(j.total || 0) - Number(j.paid || 0)), 0))} label={t('bizDash.balanceOwed')} />,
    );
  }
  if (runs) {
    const label = tools.includes('production') ? t('bizDash.batchesToday') : t('bizDash.breakdownsToday');
    cards.push(<Metric key="r1" value={runs.filter((r) => isToday(r.created_at)).length} label={label} />);
  }
  if (waste) {
    cards.push(
      <Metric key="w1" value={(waste.fresh || []).filter((f) => soon(f.next_expiry)).length} label={t('bizDash.expiringSoon')} />,
      <Metric key="w2" value={formatCurrency(waste.totalValue || 0)} label={t('bizDash.wasteWeek')} />,
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{BUSINESS_TYPES[type].icon} {t(`businessType.t_${type}`)}</h3>
        <Link to="/settings" className="muted small">{t('bizDash.change')}</Link>
      </div>
      <div className="flex mt-1" style={{ flexWrap: 'wrap', gap: 8 }}>
        {(tier === 'mini'
          // One person runs a Mini store: sell, add stock and see the day, first.
          ? [...new Set(['checkout', 'quickAdd', 'receive', ...(ACTIONS[type] || ACTIONS.general), 'today'])].slice(0, 6)
          : (ACTIONS[type] || ACTIONS.general)).map((a) => (
          <Link key={a} to={ACTION[a][1]} className="btn secondary small" style={{ textDecoration: 'none' }}>{ACTION[a][0]} {t(`bizDash.a_${a}`)}</Link>
        ))}
      </div>
      {cards.length > 0 && <div className="grid grid-4 mt-1">{cards}</div>}
    </div>
  );
}

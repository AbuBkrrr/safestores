import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { EmptyState } from '../components/ui.jsx';

const FILTERS = ['', 'order.', 'product.', 'user.', 'account.', 'shift.', 'store.', 'billing.'];

function describe(details) {
  if (!details || typeof details !== 'object') return '';
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

export default function ActivityLog() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isSuper = user.role === 'super_admin';
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [more, setMore] = useState(false);
  const base = isSuper ? '/super/activity' : `/stores/${user.storeId}/activity`;

  const load = (before) => api.get(base, { params: { limit: 100, action: filter || undefined, before } }).then((r) => {
    setRows((prev) => (before ? [...prev, ...r.data] : r.data));
    setMore(r.data.length === 100);
  });
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="topbar"><div><h1>{t('activityPage.title')}</h1><p className="muted">{t('activityPage.subtitle')}</p></div></div>
      <div className="card">
        <div className="form-group" style={{ maxWidth: 260 }}>
          <label htmlFor="act-filter">{t('activityPage.filter')}</label>
          <select id="act-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => <option key={f} value={f}>{f ? f.replace('.', '') : t('activityPage.all')}</option>)}
          </select>
        </div>
        {rows.length === 0 ? <EmptyState>{t('activityPage.empty')}</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('activityPage.when')}</th>{isSuper && <th>{t('activityPage.store')}</th>}<th>{t('activityPage.who')}</th><th>{t('activityPage.action')}</th><th>{t('activityPage.details')}</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(a.created_at).toLocaleString()}</td>
                    {isSuper && <td>{a.store_name || '—'}</td>}
                    <td>{a.actor_name || '—'} <span className="muted">{a.actor_role ? `(${a.actor_role})` : ''}</span></td>
                    <td><code>{a.action}</code></td>
                    <td className="muted" style={{ fontSize: 12 }}>{describe(a.details)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && <button className="btn secondary mt-1" onClick={() => load(rows[rows.length - 1].created_at)}>{t('activityPage.loadMore')}</button>}
      </div>
    </div>
  );
}

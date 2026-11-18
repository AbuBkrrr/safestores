import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, EmptyState } from '../components/ui.jsx';

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, filename) {
  const headers = ['Product', 'SKU', 'Incidents', 'Units Lost', 'Value Lost'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.sku, r.incident_count, r.units_lost, r.value_lost].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.setAttribute('download', filename);
  document.body.appendChild(link); link.click(); link.remove();
  window.URL.revokeObjectURL(url);
}

export default function ShrinkageReport() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canView = user.role === 'admin' || user.role === 'manager';

  useEffect(() => {
    if (!canView) { setLoading(false); return; }
    setLoading(true);
    api.get(`/stores/${user.storeId}/analytics/shrinkage`, { params: { days } })
      .then((r) => setReport(r.data))
      .catch(() => setError(t('shrinkagePage.loadFailed')))
      .finally(() => setLoading(false));
  }, [user.storeId, days, canView]);

  const rows = report?.byProduct || [];
  const totalValueLost = report?.totalValueLost || 0;

  if (!canView) {
    return (
      <div>
        <div className="topbar"><h1>{t('shrinkagePage.title')}</h1></div>
        <Alert type="error">{t('shrinkagePage.adminManagerOnly')}</Alert>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <h1>{t('shrinkagePage.title')}</h1>
        <div className="flex" style={{ alignItems: 'center', gap: 10 }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={7}>{t('shrinkagePage.last7')}</option>
            <option value={30}>{t('shrinkagePage.last30')}</option>
            <option value={90}>{t('shrinkagePage.last90')}</option>
            <option value={365}>{t('shrinkagePage.last365')}</option>
          </select>
          {rows.length > 0 && (
            <button
              className="btn secondary small"
              onClick={() => downloadCsv(rows, `shrinkage-${days}d-${new Date().toISOString().slice(0, 10)}.csv`)}
            >
              {t('shrinkagePage.downloadCsv')}
            </button>
          )}
        </div>
      </div>

      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>{t('shrinkagePage.desc')}</p>
      <Alert type="error">{error}</Alert>

      {!loading && (
        <div className="grid grid-4">
          <div className="card metric">
            <div className="value">{formatCurrency(totalValueLost)}</div>
            <div className="label">{t('shrinkagePage.totalValueLost')}</div>
          </div>
          <div className="card metric">
            <div className="value">{report?.totalUnitsLost ?? 0}</div>
            <div className="label">{t('shrinkagePage.totalUnitsLost')}</div>
          </div>
          <div className="card metric">
            <div className="value">{rows.length}</div>
            <div className="label">{t('shrinkagePage.productsAffected')}</div>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>{t('shrinkagePage.byProduct')}</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>{t('shrinkagePage.sourceNote')}</p>

        {!loading && rows.length === 0 && <EmptyState>{t('shrinkagePage.noShrinkage')}</EmptyState>}

        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('shrinkagePage.product')}</th>
                <th>{t('shrinkagePage.incidents')}</th>
                <th>{t('shrinkagePage.unitsLost')}</th>
                <th>{t('shrinkagePage.valueLost')}</th>
                <th>{t('shrinkagePage.shareOfTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product_id}>
                  <td>{r.name} <span className="muted">({r.sku})</span></td>
                  <td>{r.incident_count}</td>
                  <td>{r.units_lost}</td>
                  <td style={{ fontWeight: 600, color: '#b33a3a' }}>{formatCurrency(r.value_lost)}</td>
                  <td>{totalValueLost > 0 ? `${((r.value_lost / totalValueLost) * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

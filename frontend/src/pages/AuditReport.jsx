import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, filename) {
  const headers = [
    'Product', 'SKU', 'Product Location', 'First Arrival', 'Period From', 'Period To',
    'Received', 'Sold', 'Damaged/Expired', 'Transferred to Shelf',
    'System Shelf Qty', 'System Backroom Qty', 'System Total',
    'Shelf Count', 'Shelf Count Location', 'Backroom/Warehouse Count', 'Backroom/Warehouse Zone',
    'Counted Total', 'Total Discrepancy',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const shelfLoc = r.shelfAudit
      ? [r.shelfAudit.floor_number && `Floor ${r.shelfAudit.floor_number}`, r.shelfAudit.shelf_number && `Shelf ${r.shelfAudit.shelf_number}`, r.shelfAudit.row_number && `Row ${r.shelfAudit.row_number}`].filter(Boolean).join(' ')
      : '';
    lines.push([
      r.productName, r.sku, r.location, r.firstArrivalDate, r.periodFrom, r.periodTo,
      r.receivedQty, r.soldQty, r.damagedQty, r.transferredToShelfQty,
      r.systemShelfQty, r.systemBackroomQty, r.systemTotalQty,
      r.shelfAudit?.counted_qty ?? '', shelfLoc,
      r.backroomAudit?.counted_qty ?? '', r.backroomAudit?.zone ?? '',
      r.countedTotalQty ?? '', r.totalDiscrepancy ?? '',
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.setAttribute('download', filename);
  document.body.appendChild(link); link.click(); link.remove();
  window.URL.revokeObjectURL(url);
}

export default function AuditReport() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [report, setReport] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.get(`/stores/${user.storeId}/audits/report`, { params: { from: from || undefined, to: to || undefined } })
      .then((r) => setReport(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [user.storeId]);

  return (
    <div>
      <div className="topbar">
        <h1>{t('auditReportPage.title')}</h1>
        <Link className="btn secondary small" to="/shelf-audit">{t('auditReportPage.backToShelfAudit')}</Link>
      </div>
      <p className="muted">
        {t('auditReportPage.desc')}
      </p>

      <div className="card">
        <div className="grid grid-2">
          <div className="form-group">
            <label>{t('auditReportPage.fromLabel')}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="form-group">
            <label>{t('auditReportPage.toLabel')}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex">
          <button className="btn" onClick={load} disabled={loading}>{loading ? t('auditReportPage.loading') : t('auditReportPage.runReport')}</button>
          <button className="btn secondary" onClick={() => downloadCsv(report, `audit-report-${new Date().toISOString().slice(0, 10)}.csv`)}>{t('auditReportPage.downloadCsv')}</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{t('auditReportPage.product')}</th><th>{t('auditReportPage.firstArrival')}</th><th>{t('auditReportPage.received')}</th><th>{t('auditReportPage.sold')}</th><th>{t('auditReportPage.damaged')}</th>
              <th>{t('auditReportPage.systemShelf')}</th><th>{t('auditReportPage.systemBackroom')}</th><th>{t('auditReportPage.shelfCount')}</th><th>{t('auditReportPage.backroomCount')}</th>
              <th>{t('auditReportPage.discrepancy')}</th>
            </tr>
          </thead>
          <tbody>
            {report.map((r) => (
              <tr key={r.productId}>
                <td>{r.productName} <span className="muted">({r.sku})</span></td>
                <td>{r.firstArrivalDate ? new Date(r.firstArrivalDate).toLocaleDateString() : '—'}</td>
                <td>{r.receivedQty}</td>
                <td>{r.soldQty}</td>
                <td>{r.damagedQty}</td>
                <td>{r.systemShelfQty}</td>
                <td>{r.systemBackroomQty}</td>
                <td>
                  {r.shelfAudit ? (
                    <>
                      {r.shelfAudit.counted_qty}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[r.shelfAudit.floor_number && `Floor ${r.shelfAudit.floor_number}`, r.shelfAudit.shelf_number && `Shelf ${r.shelfAudit.shelf_number}`, r.shelfAudit.row_number && `Row ${r.shelfAudit.row_number}`].filter(Boolean).join(', ')}
                      </div>
                    </>
                  ) : <span className="muted">{t('auditReportPage.notCounted')}</span>}
                </td>
                <td>
                  {r.backroomAudit ? (
                    <>
                      {r.backroomAudit.counted_qty}
                      <div className="muted" style={{ fontSize: 12 }}>{r.backroomAudit.zone || r.backroomAudit.area}</div>
                    </>
                  ) : <span className="muted">{t('auditReportPage.notCounted')}</span>}
                </td>
                <td style={{ color: r.totalDiscrepancy ? '#b33a3a' : 'inherit', fontWeight: r.totalDiscrepancy ? 700 : 400 }}>
                  {r.totalDiscrepancy === null ? '—' : (r.totalDiscrepancy > 0 ? `+${r.totalDiscrepancy}` : r.totalDiscrepancy)}
                </td>
              </tr>
            ))}
            {report.length === 0 && !loading && (
              <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>{t('auditReportPage.noProductsYet')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

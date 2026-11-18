import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Badge, EmptyState, Modal } from '../components/ui.jsx';
import { methodLabel } from '../utils/receipt.js';

/** Shift history + the Z-report (end-of-shift cash-up) for each shift. */
export default function Shifts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency: f } = useCurrency();
  const [rows, setRows] = useState([]);
  const [report, setReport] = useState(null);

  useEffect(() => {
    api.get(`/stores/${user.storeId}/shifts`).then((r) => setRows(Array.isArray(r.data) ? r.data : []));
  }, [user.storeId]);

  const openReport = async (id) => setReport((await api.get(`/stores/${user.storeId}/shifts/${id}/report`)).data);

  const varianceStyle = (v) => ({ color: v == null ? undefined : Math.abs(v) < 0.01 ? 'var(--secondary)' : 'var(--danger)', fontWeight: 600 });

  return (
    <div>
      <div className="topbar"><div><h1>{t('shift.title')}</h1><p className="muted">{t('shift.subtitle')}</p></div></div>
      <div className="card">
        {rows.length === 0 ? <EmptyState>{t('shift.empty')}</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('shift.cashier')}</th><th>{t('shift.started')}</th><th>{t('shift.ended')}</th><th>{t('shift.status')}</th><th style={{ textAlign: 'right' }}>{t('shift.expectedCash')}</th><th style={{ textAlign: 'right' }}>{t('shift.countedCash')}</th><th style={{ textAlign: 'right' }}>{t('shift.variance')}</th><th></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.opened_by_name}</td>
                    <td>{new Date(s.opened_at).toLocaleString()}</td>
                    <td>{s.closed_at ? new Date(s.closed_at).toLocaleString() : '—'}</td>
                    <td><Badge status={s.status} /></td>
                    <td style={{ textAlign: 'right' }}>{s.expected_cash == null ? '—' : f(s.expected_cash)}</td>
                    <td style={{ textAlign: 'right' }}>{s.counted_cash == null ? '—' : f(s.counted_cash)}</td>
                    <td style={{ textAlign: 'right', ...varianceStyle(s.variance == null ? null : Number(s.variance)) }}>{s.variance == null ? '—' : f(s.variance)}</td>
                    <td><button className="btn small secondary" onClick={() => openReport(s.id)}>{t('shift.zReport')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {report && (
        <Modal title={`${t('shift.zReport')} — ${report.shift.opened_by_name || ''}`} onClose={() => setReport(null)}>
          <div className="z-report">
            <p className="muted">{new Date(report.shift.opened_at).toLocaleString()} → {report.shift.closed_at ? new Date(report.shift.closed_at).toLocaleString() : t('shift.stillOpen')}</p>
            <h4 className="mt-1">{t('shift.sales')}</h4>
            <div className="flex-between"><span>{t('shift.salesCount')}</span><span>{report.sales.count}</span></div>
            <div className="flex-between"><span>{t('shift.unitsSold')}</span><span>{report.sales.units}</span></div>
            <div className="flex-between"><span>{t('shift.gross')}</span><span>{f(report.sales.gross)}</span></div>
            <div className="flex-between"><span>{t('receipt.discount')}</span><span>{f(report.sales.discounts)}</span></div>
            <div className="flex-between"><span>{t('receipt.tax')}</span><span>{f(report.sales.tax)}</span></div>
            <div className="flex-between"><span>{t('receipt.refunded')}</span><span>−{f(report.refunds.total)}</span></div>
            <div className="flex-between" style={{ fontWeight: 700 }}><span>{t('shift.net')}</span><span>{f(report.net)}</span></div>
            <h4 className="mt-1">{t('shift.byMethod')}</h4>
            {report.payments.map((p) => <div key={p.method} className="flex-between"><span>{methodLabel(p.method)}</span><span>{f(p.total)}</span></div>)}
            <h4 className="mt-1">{t('shift.cashDrawer')}</h4>
            <div className="flex-between"><span>{t('shift.openingFloatShort')}</span><span>{f(report.cash.openingFloat)}</span></div>
            <div className="flex-between"><span>+ {t('shift.cashSales')}</span><span>{f(report.cash.cashSales)}</span></div>
            <div className="flex-between"><span>− {t('shift.cashRefunds')}</span><span>{f(report.cash.cashRefunds)}</span></div>
            <div className="flex-between" style={{ fontWeight: 700 }}><span>{t('shift.expectedCash')}</span><span>{f(report.cash.expected)}</span></div>
            {report.cash.counted != null && <>
              <div className="flex-between"><span>{t('shift.countedCash')}</span><span>{f(report.cash.counted)}</span></div>
              <div className="flex-between" style={varianceStyle(report.cash.variance)}><span>{t('shift.variance')}</span><span>{f(report.cash.variance)}</span></div>
            </>}
            {report.shift.notes && <p className="muted mt-1">📝 {report.shift.notes}</p>}
          </div>
          <div className="modal-actions"><button className="btn secondary" onClick={() => window.print()}>{t('checkout.print')}</button><button className="btn" onClick={() => setReport(null)}>{t('common.close')}</button></div>
        </Modal>
      )}
    </div>
  );
}

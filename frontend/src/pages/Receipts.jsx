import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

const SYNC_EVENTS = ['receipt:uploaded', 'receipt:applied', 'receipt:rejected'];

export default function Receipts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [receipts, setReceipts] = useState([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [toast, showToast] = useToast();
  const fileRef = useRef();

  const load = () => api.get(`/stores/${user.storeId}/receipts`).then((r) => setReceipts(r.data));
  useEffect(() => { load(); }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => load());

  const handleUpload = async (e) => {
    e.preventDefault();
    const file = fileRef.current.files[0];
    if (!file) return setError(t('receiptsPage.chooseImageFirst'));
    setError(''); setUploading(true);
    const fd = new FormData();
    fd.append('receipt', file);
    try {
      await api.post(`/stores/${user.storeId}/receipts`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      fileRef.current.value = '';
      showToast(t('receiptsPage.uploadedAndParsed'), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('receiptsPage.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const [arrivalDateOverrides, setArrivalDateOverrides] = useState({});
  // Per-line expiry / batch captured on the invoice: { [receiptId]: [{ expiryDate, batchNumber, noExpiry }] }
  const [lineInfo, setLineInfo] = useState({});
  const setLine = (rid, i, patch) => setLineInfo((prev) => {
    const arr = [...(prev[rid] || [])];
    arr[i] = { ...(arr[i] || {}), ...patch };
    return { ...prev, [rid]: arr };
  });
  const lineReady = (rid, i) => { const l = (lineInfo[rid] || [])[i] || {}; return l.noExpiry || /^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate || ''); };

  const applyReceipt = async (id, defaultDate) => {
    const arrivalDate = arrivalDateOverrides[id] || defaultDate || undefined;
    try {
      const r = receipts.find((x) => x.id === id);
      const items = (r?.parsed_items || []).map((_, i) => (lineInfo[id] || [])[i] || {});
      await api.post(`/stores/${user.storeId}/receipts/${id}/apply`, { arrivalDate, items });
      showToast(t('receiptsPage.appliedToStock'), 'success');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || t('receiptsPage.applyFailed'), 'error');
    }
  };

  const rejectReceipt = async (id) => {
    await api.post(`/stores/${user.storeId}/receipts/${id}/reject`);
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>{t('receiptsPage.title')}</h1></div>

      <div className="card">
        <Alert type="error">{error}</Alert>
        <Alert type="info">
          {t('receiptsPage.dropReceiptHint')}
        </Alert>
        <form onSubmit={handleUpload} className="flex">
          <input ref={fileRef} type="file" accept="image/*" style={{ maxWidth: 300 }} />
          <button className="btn" disabled={uploading}>{uploading ? t('receiptsPage.uploading') : t('receiptsPage.uploadAndScan')}</button>
        </form>
      </div>

      <div className="card">
        <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('receiptsPage.receiptHistory')}</h3>
        {receipts.map((r) => (
          <div key={r.id} className="card" style={{ background: 'var(--bg)' }}>
            <div className="flex-between">
              <strong>{t('receiptsPage.receiptLabel', { id: r.id.slice(0, 8) })}</strong>
              <Badge status={r.status} />
            </div>
            <table className="mt-1">
              <thead><tr><th>{t('receiptsPage.item')}</th><th>{t('receiptsPage.qty')}</th><th>{t('receiptsPage.price')}</th>{r.status === 'pending' && <><th>{t('receiptsPage.expiry')} *</th><th>{t('receiptsPage.batch')}</th></>}</tr></thead>
              <tbody>
                {r.parsed_items.map((it, i) => {
                  const l = (lineInfo[r.id] || [])[i] || {};
                  return (
                    <tr key={i} style={r.status === 'pending' && !lineReady(r.id, i) ? { background: 'var(--offline-bg)' } : undefined}>
                      <td>{it.name}</td><td>{it.quantity}</td><td>{formatCurrency(it.price)}</td>
                      {r.status === 'pending' && <>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <input type="date" aria-label={t('receiptsPage.expiryFor', { name: it.name })} disabled={l.noExpiry} value={l.expiryDate || ''} onChange={(e) => setLine(r.id, i, { expiryDate: e.target.value })} />
                          <label style={{ fontSize: 12, marginLeft: 6 }}><input type="checkbox" checked={!!l.noExpiry} onChange={(e) => setLine(r.id, i, { noExpiry: e.target.checked })} /> {t('receiptsPage.noExpiry')}</label>
                        </td>
                        <td><input aria-label={t('receiptsPage.batchFor', { name: it.name })} value={l.batchNumber || ''} onChange={(e) => setLine(r.id, i, { batchNumber: e.target.value })} style={{ width: 110 }} /></td>
                      </>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {r.status === 'pending' && (
              <>
                <div className="flex mt-1" style={{ alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 14 }}>
                    {r.document_date ? t('receiptsPage.arrivalDateFound') : t('receiptsPage.arrivalDateNotFound')}
                  </label>
                  <input
                    type="date"
                    value={arrivalDateOverrides[r.id] ?? r.document_date ?? ''}
                    onChange={(e) => setArrivalDateOverrides((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                </div>
                <div className="flex mt-1">
                  <button className="btn small" disabled={!r.parsed_items.every((_, i) => lineReady(r.id, i))} title={t('receiptsPage.expiryNeeded')} onClick={() => applyReceipt(r.id, r.document_date)}>{t('receiptsPage.applyToStock')}</button>
                  {!r.parsed_items.every((_, i) => lineReady(r.id, i)) && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{t('receiptsPage.expiryNeeded')}</span>}
                  <button className="btn secondary small" onClick={() => rejectReceipt(r.id)}>{t('receiptsPage.reject')}</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

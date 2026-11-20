import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { useStoreProfile } from '../utils/useStoreTier.js';
import { BUSINESS_TYPES } from '../utils/businessTypes.js';

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
  // Categories to suggest: the trade's starter list plus every one the store
  // already uses; existing products show their category, new ones get a box.
  const { businessType } = useStoreProfile();
  const [products, setProducts] = useState([]);
  useEffect(() => { api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(Array.isArray(r.data) ? r.data : [])).catch(() => {}); }, [user.storeId]);
  const byName = new Map(products.map((p) => [String(p.name).toLowerCase(), p]));
  const categories = [...new Set([...(BUSINESS_TYPES[businessType] || BUSINESS_TYPES.general).categories, ...products.map((p) => p.category).filter(Boolean)])].sort();
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
  // Profit % on the invoice (owner and managers): one figure for the whole
  // invoice, an optional figure per line, and whether items already in stock
  // take the new price too.
  const canPrice = ['admin', 'manager'].includes(user?.role);
  const [invoiceMarkup, setInvoiceMarkup] = useState({}); // { [receiptId]: { percent, existing } }
  const setInvMk = (rid, patch) => setInvoiceMarkup((m) => ({ ...m, [rid]: { ...(m[rid] || {}), ...patch } }));

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
      const mk = invoiceMarkup[id] || {};
      await api.post(`/stores/${user.storeId}/receipts/${id}/apply`, { arrivalDate, items, markupPercent: mk.percent === undefined || mk.percent === '' ? undefined : Number(mk.percent), markupExisting: !!mk.existing });
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
              <thead><tr><th>{t('receiptsPage.item')}</th><th>{t('receiptsPage.qty')}</th><th>{t('receiptsPage.price')}</th>{r.status === 'pending' && <>{canPrice && <th>{t('markup.lineProfit')}</th>}<th>{t('receiptsPage.category')}</th><th>{t('receiptsPage.expiry')} *</th><th>{t('receiptsPage.batch')}</th></>}</tr></thead>
              <tbody>
                {r.parsed_items.map((it, i) => {
                  const l = (lineInfo[r.id] || [])[i] || {};
                  return (
                    <tr key={i} style={r.status === 'pending' && !lineReady(r.id, i) ? { background: 'var(--offline-bg)' } : undefined}>
                      <td>{it.name}</td><td>{it.quantity}</td><td>{formatCurrency(it.price)}</td>
                      {r.status === 'pending' && <>
                        {canPrice && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <input type="number" min="0" max="1000" step="0.5" aria-label={t('markup.lineProfitFor', { name: it.name })} placeholder={invoiceMarkup[r.id]?.percent || ''}
                              value={l.markupPercent ?? ''} onChange={(e) => setLine(r.id, i, { markupPercent: e.target.value })} style={{ width: 70 }} />
                            {(l.markupPercent ?? invoiceMarkup[r.id]?.percent) !== undefined && (l.markupPercent ?? invoiceMarkup[r.id]?.percent) !== '' && Number(it.price) > 0 && (
                              <div className="muted" style={{ fontSize: 11 }}>→ {formatCurrency(Number(it.price) * (1 + Number(l.markupPercent || invoiceMarkup[r.id]?.percent) / 100))}</div>
                            )}
                          </td>
                        )}
                        <td>
                          {byName.get(String(it.name).toLowerCase())?.category
                            ? <span className="muted">{byName.get(String(it.name).toLowerCase()).category}</span>
                            : <>
                              <input list="rc-cats" aria-label={t('receiptsPage.categoryFor', { name: it.name })} placeholder={byName.has(String(it.name).toLowerCase()) ? '' : t('receiptsPage.newItem')}
                                value={l.category ?? it.category ?? ''} onChange={(e) => setLine(r.id, i, { category: e.target.value })} style={{ width: 150 }} />
                            </>}
                        </td>
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
            {r.status === 'pending' && canPrice && (
              <div className="flex mt-1" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label htmlFor={`inv-mk-${r.id}`} style={{ fontWeight: 600 }}>💹 {t('markup.invoiceProfit')}</label>
                <input id={`inv-mk-${r.id}`} type="number" min="0" max="1000" step="0.5" value={invoiceMarkup[r.id]?.percent ?? ''} onChange={(e) => setInvMk(r.id, { percent: e.target.value })} style={{ width: 90 }} />
                <label style={{ fontSize: 13 }}><input type="checkbox" checked={!!invoiceMarkup[r.id]?.existing} onChange={(e) => setInvMk(r.id, { existing: e.target.checked })} /> {t('markup.alsoExisting')}</label>
                <span className="help-text">{t('markup.invoiceHelp')}</span>
              </div>
            )}
            {r.status === 'pending' && <datalist id="rc-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>}
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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Alert, Badge, EmptyState, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

/** Send stock to, and receive stock from, your other branches. */
export default function Transfers() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [branches, setBranches] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ toStoreId: '', note: '', lines: [{ productId: '', quantity: '' }] });
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const base = `/stores/${user.storeId}/transfers`;

  const load = () => api.get(base).then((r) => setRows(r.data));
  useEffect(() => {
    load();
    api.get(`${base}/destinations`).then((r) => setBranches(r.data));
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts((r.data || []).filter((p) => !p.archived_at && p.backroom_qty > 0)));
  }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(base, { toStoreId: form.toStoreId, note: form.note || undefined, items: form.lines.filter((l) => l.productId && Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) });
      setForm({ toStoreId: '', note: '', lines: [{ productId: '', quantity: '' }] });
      showToast(t('transfersPage.sent'), 'success');
      load();
    } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
  };

  const act = async (id, action) => {
    setError('');
    try { const { data } = await api.post(`${base}/${id}/${action}`); showToast(data.message, 'success'); load(); } catch (err) { setError(err.response?.data?.error || t('common.errorGeneric')); }
  };

  const setLine = (i, k, v) => setForm({ ...form, lines: form.lines.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)) });

  return (
    <div>
      <div className="topbar"><div><h1>{t('transfersPage.title')}</h1><p className="muted">{t('transfersPage.subtitle')}</p></div></div>
      <Alert type="error">{error}</Alert>
      {branches.length === 0 ? <Alert type="info">{t('transfersPage.noBranches')}</Alert> : (
        <form className="card" onSubmit={send}>
          <h3>{t('transfersPage.new')}</h3>
          <div className="form-group">
            <label htmlFor="tr-to">{t('transfersPage.to')}</label>
            <select id="tr-to" value={form.toStoreId} onChange={(e) => setForm({ ...form, toStoreId: e.target.value })} required>
              <option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.city ? ` (${b.city})` : ''}</option>)}
            </select>
          </div>
          {form.lines.map((l, i) => (
            <div className="flex" key={i} style={{ marginBottom: 6 }}>
              <select aria-label={`${t('transfersPage.product')} ${i + 1}`} value={l.productId} onChange={(e) => setLine(i, 'productId', e.target.value)} style={{ maxWidth: 320 }}>
                <option value="">{t('transfersPage.product')}…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({t('transfersPage.inBackroom', { count: p.backroom_qty })})</option>)}
              </select>
              <input aria-label={`${t('transfersPage.qty')} ${i + 1}`} type="number" min="1" placeholder={t('transfersPage.qty')} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} style={{ maxWidth: 110 }} />
            </div>
          ))}
          <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, lines: [...form.lines, { productId: '', quantity: '' }] })}>+ {t('transfersPage.addLine')}</button>
          <div className="form-group mt-1"><label htmlFor="tr-note">{t('transfersPage.note')}</label><input id="tr-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <button className="btn">{t('transfersPage.send')}</button>
        </form>
      )}

      <div className="card">
        <h3>{t('transfersPage.history')}</h3>
        {rows.length === 0 ? <EmptyState>{t('transfersPage.empty')}</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{t('transfersPage.when')}</th><th>{t('transfersPage.direction')}</th><th>{t('transfersPage.items')}</th><th>{t('transfersPage.status')}</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.direction === 'out' ? `→ ${r.to_store_name}` : `← ${r.from_store_name}`}</td>
                <td>{(r.items || []).map((i) => `${i.name} × ${i.quantity}`).join(', ')}{r.note ? <div className="muted">{r.note}</div> : null}</td>
                <td><Badge status={r.status === 'in_transit' ? 'in_progress' : r.status === 'received' ? 'completed' : 'cancelled'} /></td>
                <td>
                  {r.status === 'in_transit' && r.direction === 'in' && <button className="btn small" onClick={() => act(r.id, 'receive')}>{t('transfersPage.receive')}</button>}
                  {r.status === 'in_transit' && r.direction === 'out' && <button className="btn small secondary" onClick={() => act(r.id, 'cancel')}>{t('common.cancel')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

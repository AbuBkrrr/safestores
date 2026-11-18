import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert } from '../components/ui.jsx';

// Store room → shelf handovers. The store manager sends stock; the shelf
// manager confirms what actually arrived. Stock moves only on confirmation.
export default function Handovers() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const base = `/stores/${user.storeId}/handovers`;
  const canIssue = ['admin', 'manager', 'store_manager'].includes(user.role);
  const canReceive = ['admin', 'manager', 'staff', 'shelf_manager'].includes(user.role);
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([{ productId: '', quantity: '' }]);
  const [note, setNote] = useState('');
  const [got, setGot] = useState({});
  const [recvNote, setRecvNote] = useState({});
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = () => api.get(base).then((r) => setList(r.data)).catch(() => {});
  useEffect(() => {
    load();
    if (canIssue) api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data.filter((p) => p.backroom_qty > 0))).catch(() => {});
  }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeEvents(['handover:issued', 'handover:received'], () => load());

  const run = async (fn, ok) => {
    setMsg({});
    try { await fn(); setMsg({ type: 'success', text: t(ok) }); load(); return true; } catch (e) { setMsg({ type: 'error', text: e.response?.data?.error || t('handover.failed') }); return false; }
  };
  const issue = async (e) => {
    e.preventDefault();
    const items = lines.filter((l) => l.productId && parseInt(l.quantity, 10) > 0);
    if (await run(() => api.post(base, { items, note }), 'handover.issued')) { setLines([{ productId: '', quantity: '' }]); setNote(''); }
  };
  const receive = (h) => run(() => api.post(`${base}/${h.id}/receive`, {
    items: h.items.map((i) => ({ itemId: i.id, qtyReceived: got[i.id] ?? i.qty_issued })), note: recvNote[h.id] || '',
  }), 'handover.received');

  const open = list.filter((h) => h.status === 'issued');
  const done = list.filter((h) => h.status !== 'issued');
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  return (
    <div>
      <div className="topbar"><div className="page-title"><h1>📦➡️🛒 {t('handover.title')}</h1><div className="sub">{t('handover.sub')}</div></div></div>
      <Alert type={msg.type}>{msg.text}</Alert>

      {canIssue && (
        <div className="card">
          <h3>{t('handover.sendTitle')}</h3>
          <form onSubmit={issue}>
            {lines.map((l, i) => (
              <div key={i} className="flex" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <select aria-label={t('handover.product')} value={l.productId} onChange={(e) => setLine(i, 'productId', e.target.value)} style={{ flex: 2, minWidth: 200 }}>
                  <option value="">{t('handover.chooseProduct')}</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} — {t('handover.inStoreRoom', { n: p.backroom_qty })}</option>)}
                </select>
                <input type="number" min="1" aria-label={t('handover.qty')} placeholder={t('handover.qty')} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} style={{ width: 110 }} />
                {lines.length > 1 && <button type="button" className="btn small secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button type="button" className="btn small secondary" onClick={() => setLines([...lines, { productId: '', quantity: '' }])}>+ {t('handover.addLine')}</button>
            <div className="form-group mt-1"><label htmlFor="ho-note">{t('handover.note')}</label><input id="ho-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('handover.notePh')} /></div>
            <button className="btn" type="submit">{t('handover.send')}</button>
          </form>
        </div>
      )}

      <div className="card">
        <h3>{t('handover.waiting')} {open.length > 0 && <span className="badge pending">{open.length}</span>}</h3>
        {open.length === 0 ? <p className="muted">{t('handover.noneWaiting')}</p> : open.map((h) => (
          <div key={h.id} className="card mt-1" style={{ background: 'var(--bg)' }}>
            <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <strong>{t('handover.from', { name: h.issued_by_name || '—' })}</strong>
              <span className="muted">{new Date(h.issued_at).toLocaleString()}</span>
            </div>
            {h.note && <p className="muted" style={{ margin: '4px 0' }}>{h.note}</p>}
            <table className="mt-1">
              <thead><tr><th>{t('handover.product')}</th><th style={{ textAlign: 'right' }}>{t('handover.sent')}</th>{canReceive && <th>{t('handover.receivedCol')}</th>}</tr></thead>
              <tbody>{h.items.map((i) => (
                <tr key={i.id}><td>{i.name}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{i.qty_issued}</td>
                  {canReceive && <td><input type="number" min="0" max={i.qty_issued} aria-label={t('handover.receivedOf', { name: i.name })} value={got[i.id] ?? i.qty_issued} onChange={(e) => setGot({ ...got, [i.id]: e.target.value })} style={{ width: 90 }} /></td>}
                </tr>
              ))}</tbody>
            </table>
            <div className="flex mt-1" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {canReceive && <>
                <input aria-label={t('handover.recvNote')} placeholder={t('handover.recvNote')} value={recvNote[h.id] || ''} onChange={(e) => setRecvNote({ ...recvNote, [h.id]: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
                <button className="btn" onClick={() => receive(h)}>✅ {t('handover.confirm')}</button>
              </>}
              {canIssue && <button className="btn small secondary" onClick={() => run(() => api.post(`${base}/${h.id}/cancel`), 'handover.cancelled')}>{t('handover.cancel')}</button>}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>{t('handover.history')}</h3>
        {done.length === 0 ? <p className="muted">{t('handover.noHistory')}</p> : (
          <div style={{ overflowX: 'auto' }}><table>
            <thead><tr><th>{t('handover.when')}</th><th>{t('handover.sentBy')}</th><th>{t('handover.receivedBy')}</th><th>{t('handover.items')}</th><th>{t('handover.status')}</th></tr></thead>
            <tbody>{done.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.issued_at).toLocaleString()}</td><td>{h.issued_by_name || '—'}</td><td>{h.received_by_name || '—'}</td>
                <td>{h.items.map((i) => `${i.name} ${i.qty_received ?? '—'}/${i.qty_issued}`).join(', ')}{h.receive_note && <div className="muted" style={{ fontSize: 11 }}>{h.receive_note}</div>}</td>
                <td><span className={`badge ${h.status === 'short' ? 'pending' : h.status === 'received' ? 'active' : 'closed'}`}>{t(`handover.st_${h.status}`)}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

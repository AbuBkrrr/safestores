import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert } from '../components/ui.jsx';

export const slipCode = (id) => String(id).replace(/-/g, '').slice(0, 8).toUpperCase();
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Printable handover slip; its QR is scanned by the shelf manager on receipt. */
async function printSlip(h, storeName) {
  const qr = await QRCode.toDataURL(`SSHO:${h.id}`, { width: 180, margin: 1 });
  const rows = h.items.map((i) => `<tr><td>${escHtml(i.name)}</td><td style="text-align:right">${i.qty_issued}</td><td style="width:90px"></td></tr>`).join('');
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Handover slip ${slipCode(h.id)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #999;padding:6px;text-align:left}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}.line{border-top:1px solid #111;padding-top:4px;margin-top:36px;font-size:12px}
@media print{button{display:none}}</style></head><body>
<button onclick="window.print()" style="float:right">Print</button>
<div class="top"><div><h2 style="margin:0">${escHtml(storeName)}</h2><div>Store room → shelf handover</div>
<div style="font-size:28px;font-weight:800;letter-spacing:.08em;margin-top:8px">${slipCode(h.id)}</div>
<div>${escHtml(new Date(h.issued_at).toLocaleString())} · Sent by ${escHtml(h.issued_by_name || '')}</div>${h.note ? `<div>${escHtml(h.note)}</div>` : ''}</div>
<div style="text-align:center"><img src="${qr}" width="160" height="160" alt="QR"><div style="font-size:11px">Shelf manager: scan to confirm</div></div></div>
<table><thead><tr><th>Product</th><th style="text-align:right">Sent</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sign"><div class="line">Store manager (sent)</div><div class="line">Shelf manager (received)</div></div>
</body></html>`);
  w.document.close();
}

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
  const [focusId, setFocusId] = useState(null);
  const [scanCode, setScanCode] = useState('');
  const [camera, setCamera] = useState(false);
  const videoRef = useRef(null);
  const [returns, setReturns] = useState([]);
  const [split, setSplit] = useState({});
  const canTakeReturns = ['admin', 'manager', 'store_manager'].includes(user.role);

  const load = () => {
    api.get(base).then((r) => setList(r.data)).catch(() => {});
    if (canTakeReturns) api.get(`/stores/${user.storeId}/returns`).then((r) => setReturns(r.data)).catch(() => {});
  };
  // Scanned slip (SSHO:<id>) or typed 8-character code → open that handover.
  const findSlip = (raw) => {
    const c = String(raw || '').trim();
    const id = c.startsWith('SSHO:') ? c.slice(5) : null;
    const h = list.find((x) => x.status === 'issued' && (id ? x.id === id : slipCode(x.id) === c.toUpperCase()));
    if (h) { setFocusId(h.id); setMsg({ type: 'success', text: t('handover.slipFound', { code: slipCode(h.id) }) }); }
    else setMsg({ type: 'error', text: t('handover.slipNotFound') });
  };
  useEffect(() => {
    if (!camera || !videoRef.current) return undefined;
    let stream; let done = false;
    const reader = new BrowserMultiFormatReader();
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s; if (!videoRef.current) return;
      videoRef.current.srcObject = s;
      reader.decodeFromVideoElement(videoRef.current, (result) => {
        if (!result || done) return;
        done = true; setCamera(false); findSlip(result.getText());
      }).catch(() => {});
    }).catch(() => { setCamera(false); setMsg({ type: 'error', text: t('handover.cameraError') }); });
    return () => { try { reader.reset?.(); } catch { /* ignore */ } stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);
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
    let created = null;
    if (await run(async () => { created = (await api.post(base, { items, note })).data; }, 'handover.issued')) {
      setLines([{ productId: '', quantity: '' }]); setNote('');
      // Print the slip straight away so it travels with the goods.
      const full = (await api.get(base)).data.find((x) => x.id === created?.id);
      if (full) printSlip(full, user.storeName || '');
    }
  };
  const receive = (h) => run(() => api.post(`${base}/${h.id}/receive`, {
    items: h.items.map((i) => ({ itemId: i.id, qtyReceived: got[i.id] ?? i.qty_issued })), note: recvNote[h.id] || '',
  }), 'handover.received');

  const open = list.filter((h) => h.status === 'issued').sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));
  const pendingReturns = returns.filter((r) => !r.received_at);
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
                <input type="number" step="any" min="1" aria-label={t('handover.qty')} placeholder={t('handover.qty')} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} style={{ width: 110 }} />
                {lines.length > 1 && <button type="button" className="btn small secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button type="button" className="btn small secondary" onClick={() => setLines([...lines, { productId: '', quantity: '' }])}>+ {t('handover.addLine')}</button>
            <div className="form-group mt-1"><label htmlFor="ho-note">{t('handover.note')}</label><input id="ho-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('handover.notePh')} /></div>
            <button className="btn" type="submit">{t('handover.send')}</button>
          </form>
        </div>
      )}

      {canReceive && (
        <div className="card">
          <h3>📷 {t('handover.scanTitle')}</h3>
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={`btn ${camera ? 'secondary' : ''}`} onClick={() => setCamera((c) => !c)}>{camera ? t('handover.stopCamera') : `📷 ${t('handover.scanSlip')}`}</button>
            <form className="flex" style={{ gap: 8, flex: 1, minWidth: 200 }} onSubmit={(e) => { e.preventDefault(); findSlip(scanCode); }}>
              <input id="slip-code" aria-label={t('handover.slipCode')} placeholder={t('handover.slipCode')} value={scanCode} onChange={(e) => setScanCode(e.target.value)} style={{ flex: 1 }} />
              <button className="btn secondary" disabled={!scanCode.trim()}>{t('handover.find')}</button>
            </form>
          </div>
          {camera && <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', marginTop: 10, borderRadius: 8, background: '#000', maxHeight: 260, objectFit: 'cover' }} />}
        </div>
      )}

      <div className="card">
        <h3>{t('handover.waiting')} {open.length > 0 && <span className="badge pending">{open.length}</span>}</h3>
        {open.length === 0 ? <p className="muted">{t('handover.noneWaiting')}</p> : open.map((h) => (
          <div key={h.id} className="card mt-1" style={{ background: 'var(--bg)', outline: h.id === focusId ? '3px solid var(--primary)' : undefined }}>
            <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <strong><code>{slipCode(h.id)}</code> · {t('handover.from', { name: h.issued_by_name || '—' })}</strong>
              <span className="muted">{new Date(h.issued_at).toLocaleString()}</span>
            </div>
            {h.note && <p className="muted" style={{ margin: '4px 0' }}>{h.note}</p>}
            <table className="mt-1">
              <thead><tr><th>{t('handover.product')}</th><th style={{ textAlign: 'right' }}>{t('handover.sent')}</th>{canReceive && <th>{t('handover.receivedCol')}</th>}</tr></thead>
              <tbody>{h.items.map((i) => (
                <tr key={i.id}><td>{i.name}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{i.qty_issued}</td>
                  {canReceive && <td><input type="number" step="any" min="0" max={i.qty_issued} aria-label={t('handover.receivedOf', { name: i.name })} value={got[i.id] ?? i.qty_issued} onChange={(e) => setGot({ ...got, [i.id]: e.target.value })} style={{ width: 90 }} /></td>}
                </tr>
              ))}</tbody>
            </table>
            <div className="flex mt-1" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {canReceive && <>
                <input aria-label={t('handover.recvNote')} placeholder={t('handover.recvNote')} value={recvNote[h.id] || ''} onChange={(e) => setRecvNote({ ...recvNote, [h.id]: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
                <button className="btn" onClick={() => receive(h)}>✅ {t('handover.confirm')}</button>
              </>}
              <button type="button" className="btn small secondary" onClick={() => printSlip(h, user.storeName || '')}>🖨️ {t('handover.printSlip')}</button>
              {canIssue && <button className="btn small secondary" onClick={() => run(() => api.post(`${base}/${h.id}/cancel`), 'handover.cancelled')}>{t('handover.cancel')}</button>}
            </div>
          </div>
        ))}
      </div>

      {canTakeReturns && (
        <div className="card">
          <h3>↩️ {t('handover.returnsTitle')} {pendingReturns.length > 0 && <span className="badge pending">{pendingReturns.length}</span>}</h3>
          <p className="muted" style={{ fontSize: 13 }}>{t('handover.returnsHelp')}</p>
          {returns.length === 0 ? <p className="muted">{t('handover.noReturns')}</p> : (
            <div style={{ overflowX: 'auto' }}><table>
              <thead><tr><th>{t('handover.product')}</th><th>{t('handover.receipt')}</th><th style={{ textAlign: 'right' }}>{t('handover.returnedQty')}</th><th>{t('handover.fromSecurity')}</th><th>{t('handover.intoStore')}</th></tr></thead>
              <tbody>{returns.map((r) => {
                const sp = split[r.id] || { resellable: r.quantity, damaged: 0, note: '' };
                return (
                  <tr key={r.id}>
                    <td>{r.product_name}{r.note && <div className="muted" style={{ fontSize: 11 }}>{r.note}</div>}</td>
                    <td><code>{r.receipt_number}</code></td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.quantity}</td>
                    <td style={{ fontSize: 12 }}>{r.checked_by_name || '—'}<div className="muted">{new Date(r.created_at).toLocaleString()}</div></td>
                    <td>{r.received_at
                      ? <span style={{ fontSize: 12 }}>✅ {t('handover.returnDone', { ok: r.qty_resellable, bad: r.qty_damaged, name: r.received_by_name || '—' })}</span>
                      : canTakeReturns && (
                        <span className="flex" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                          <label style={{ fontSize: 12 }}>{t('handover.resellable')} <input type="number" step="any" min="0" max={r.quantity} value={sp.resellable} onChange={(e) => setSplit({ ...split, [r.id]: { ...sp, resellable: e.target.value, damaged: Math.max(0, r.quantity - (parseInt(e.target.value, 10) || 0)) } })} style={{ width: 64 }} /></label>
                          <label style={{ fontSize: 12 }}>{t('handover.damaged')} <input type="number" step="any" min="0" max={r.quantity} value={sp.damaged} onChange={(e) => setSplit({ ...split, [r.id]: { ...sp, damaged: e.target.value } })} style={{ width: 64 }} /></label>
                          <button className="btn small" onClick={() => run(() => api.post(`/stores/${user.storeId}/returns/${r.id}/receive`, { resellable: Number(sp.resellable), damaged: Number(sp.damaged), note: sp.note }), 'handover.returnReceived')}>{t('handover.receiveReturn')}</button>
                        </span>
                      )}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </div>
      )}

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

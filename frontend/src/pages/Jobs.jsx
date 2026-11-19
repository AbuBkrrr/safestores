import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Modal } from '../components/ui.jsx';
import { useStoreProfile } from '../utils/useStoreTier.js';
import ScanProductButton from '../components/ScanProductButton.jsx';
import { RepairIntake, RepairPanel, TagCheck, itemSummary } from '../components/RepairJob.jsx';

const STEPS = ['received', 'in_progress', 'fitting', 'ready'];
const REPAIR_STEPS = ['received', 'diagnosing', 'awaiting_approval', 'waiting_parts', 'in_progress', 'ready'];
const TAILOR_FIELDS = ['Neck', 'Chest', 'Shoulder', 'Sleeve', 'Top length', 'Waist', 'Hip', 'Thigh', 'Trouser length', 'Ankle'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Services & job orders: tailor, laundry, repairs. Job ticket with the
// customer's measurements, deposit, due date, status and materials used.
export default function Jobs() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const { businessType, tools } = useStoreProfile();
  const repair = tools.includes('repair');
  const base = `/stores/${user.storeId}/jobs`;
  const fields = businessType === 'tailor' ? TAILOR_FIELDS : [];
  const steps = repair ? REPAIR_STEPS : STEPS;
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [jobs, setJobs] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const [found, setFound] = useState([]);
  const [products, setProducts] = useState([]);
  const [pay, setPay] = useState({ amount: '', method: 'cash' });
  const [mat, setMat] = useState({ productId: '', quantity: '' });
  const [msg, setMsg] = useState({});

  const load = () => api.get(base, { params: { status: showAll ? 'all' : 'open', q: q.trim() || undefined } }).then((r) => setJobs(r.data)).catch(() => {});
  useEffect(() => { const h = setTimeout(load, q ? 300 : 0); return () => clearTimeout(h); }, [showAll, q]); // eslint-disable-line react-hooks/exhaustive-deps
  // Scanning an item's QR tag (camera, USB scanner or a phone opening /jobs?tag=…) opens its job.
  const openByTag = async (code) => {
    setMsg({});
    try { const r = await api.get(`${base}/tag/${encodeURIComponent(code)}`); setOpen(r.data); setTagInput(''); }
    catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('repair.tagNotFound') }); }
  };
  useEffect(() => {
    const tag = searchParams.get('tag');
    if (tag) { openByTag(tag); setSearchParams({}, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data)).catch(() => {}); }, [user.storeId]);

  const run = async (fn, ok) => {
    setMsg({});
    try { const r = await fn(); if (ok) setMsg({ type: 'success', text: ok }); load(); return r; }
    catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('jobs.failed') }); return null; }
  };
  const newJob = () => setForm({ customerName: '', customerPhone: '', storeCustomerId: '', title: '', dueDate: '', items: [{ description: '', quantity: 1, price: '' }], deposit: '', method: 'cash', measurements: {}, notes: '', itemDetails: {}, fault: '', condition: '', accessories: '' });
  const total = form ? form.items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0), 0) : 0;
  const searchCustomer = async (q) => {
    setForm((f) => ({ ...f, customerName: q, storeCustomerId: '' }));
    if (q.trim().length < 2) { setFound([]); return; }
    const r = await api.get(`${base}/customers`, { params: { q } }).catch(() => null);
    setFound(r?.data || []);
  };
  const pickCustomer = (c) => { setForm({ ...form, storeCustomerId: c.id, customerName: c.name, customerPhone: c.phone || '', measurements: { ...(c.measurements || {}) } }); setFound([]); };
  const create = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(base, { ...form, storeCustomerId: form.storeCustomerId || undefined, saveMeasurements: true, deposit: Number(form.deposit) || 0 }), t('jobs.created'));
    if (r) { setForm(null); setOpen(r.data); }
  };
  const openJob = async (id) => { const r = await api.get(`${base}/${id}`).catch(() => null); if (r) { setOpen(r.data); setPay({ amount: '', method: 'cash' }); setMat({ productId: '', quantity: '' }); setTagInput(''); } };
  const tagOk = (j) => !j.tag_code || (tagInput && tagInput.toUpperCase().replace(/.*TAG=/, '').trim() === j.tag_code);
  const canSkipTag = ['admin', 'manager'].includes(user.role);
  const act = async (fn, ok) => { const r = await run(fn, ok); if (r) setOpen(r.data); };
  const printTicket = (j) => {
    const w = window.open('', '_blank'); if (!w) return;
    const meas = Object.entries(j.measurements || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Job ${esc(j.ref)}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:20px auto;padding:0 14px}td,th{border:1px solid #999;padding:5px}table{border-collapse:collapse;width:100%;margin:8px 0}@media print{button{display:none}}</style></head><body>
<button onclick="window.print()" style="float:right">Print</button><h2>${esc(user.storeName || '')}</h2><div style="font-size:26px;font-weight:800">Job ${esc(j.ref)}</div>
<p><b>${esc(j.customer_name)}</b> ${esc(j.customer_phone || '')}<br>${esc(j.title)}<br>Due: ${esc(j.due_date ? new Date(j.due_date).toLocaleDateString() : '—')}</p>
${j.tag_code ? `<p>Item: <b>${esc(itemSummary(j.item_details) || '—')}</b> · Tag <b>${esc(j.tag_code)}</b>${j.fault ? `<br>Fault: ${esc(j.fault)}` : ''}${j.condition_notes ? `<br>Condition: ${esc(j.condition_notes)}` : ''}${j.accessories ? `<br>Left with item: ${esc(j.accessories)}` : ''}</p>` : ''}
<table><tr><th>Item</th><th>Qty</th><th>Price</th></tr>${(j.items || []).map((i) => `<tr><td>${esc(i.description)}</td><td>${i.quantity}</td><td>${esc(formatCurrency(i.price))}</td></tr>`).join('')}</table>
<p>Total ${esc(formatCurrency(j.total))} · Paid ${esc(formatCurrency(j.paid))} · <b>Balance ${esc(formatCurrency(Number(j.total) - Number(j.paid)))}</b></p>
${meas ? `<h4>Measurements</h4><table>${meas}</table>` : ''}${j.notes ? `<p>${esc(j.notes)}</p>` : ''}<p style="font-size:12px">Bring this ticket when you collect.</p></body></html>`);
    w.document.close();
  };
  const due = (d) => {
    if (!d) return '—';
    const n = Math.round((new Date(d) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
    return n < 0 ? <span style={{ color: 'var(--danger)' }}>{t('jobs.late', { count: -n })}</span> : n === 0 ? t('jobs.today') : new Date(d).toLocaleDateString();
  };

  return (
    <div>
      <div className="topbar"><div className="page-title"><h1>{repair ? '🔧' : '🧵'} {t(repair ? 'repair.title' : 'jobs.title')}</h1><div className="sub">{t(repair ? 'repair.sub' : 'jobs.sub')}</div></div>
        {!form && <button className="btn" onClick={newJob}>+ {t('jobs.new')}</button>}</div>
      <Alert type={msg.type}>{msg.text}</Alert>

      {form && (
        <form className="card" onSubmit={create}>
          <h3>{t('jobs.new')}</h3>
          <div className="grid grid-2">
            <div className="form-group" style={{ position: 'relative' }}><label htmlFor="jb-cust">{t('jobs.customer')}</label>
              <input id="jb-cust" required value={form.customerName} onChange={(e) => searchCustomer(e.target.value)} placeholder={t('jobs.customerPh')} autoComplete="off" />
              {found.length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 5, width: '100%', padding: 6 }}>{found.map((c) => (
                <button type="button" key={c.id} className="btn small secondary" style={{ display: 'block', width: '100%', marginBottom: 4, textAlign: 'left' }} onClick={() => pickCustomer(c)}>
                  {c.name} {c.phone ? `· ${c.phone}` : ''} {Object.keys(c.measurements || {}).length ? `· 📏 ${t('jobs.hasMeasurements')}` : ''}</button>))}</div>}
              {form.storeCustomerId && <span className="muted" style={{ fontSize: 12 }}>✅ {t('jobs.returning')}</span>}</div>
            <div className="form-group"><label htmlFor="jb-phone">{t('jobs.phone')}</label><input id="jb-phone" value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} inputMode="tel" /></div>
            <div className="form-group"><label htmlFor="jb-title">{t('jobs.what')}</label><input id="jb-title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t(businessType === 'laundry' ? 'jobs.whatPhL' : 'jobs.whatPh')} /></div>
            <div className="form-group"><label htmlFor="jb-due">{t('jobs.due')}</label><input id="jb-due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
          </div>
          {repair && <RepairIntake businessType={businessType} form={form} setForm={setForm} />}
          <h4 className="mt-1">{t(repair ? 'repair.charges' : 'jobs.items')}</h4>
          {form.items.map((it, i) => (
            <div key={i} className="flex" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <input aria-label={t('jobs.itemDesc')} placeholder={t('jobs.itemDesc')} required value={it.description} onChange={(e) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} style={{ flex: 2, minWidth: 160 }} />
              <input type="number" min="0" step="any" aria-label={t('jobs.qty')} value={it.quantity} onChange={(e) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} style={{ width: 70 }} />
              <input type="number" min="0" step="any" aria-label={t('jobs.price')} placeholder={t('jobs.price')} required value={it.price} onChange={(e) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} style={{ width: 120 }} />
              {form.items.length > 1 && <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, items: form.items.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, items: [...form.items, { description: '', quantity: 1, price: '' }] })}>+ {t('jobs.addItem')}</button>
          {fields.length > 0 && (<>
            <h4 className="mt-1">📏 {t('jobs.measurements')}</h4>
            <div className="grid grid-4">{fields.map((f) => (
              <div key={f} className="form-group" style={{ margin: 0 }}><label htmlFor={`m-${f}`} style={{ fontSize: 12 }}>{f}</label>
                <input id={`m-${f}`} value={form.measurements[f] || ''} onChange={(e) => setForm({ ...form, measurements: { ...form.measurements, [f]: e.target.value } })} inputMode="decimal" /></div>
            ))}</div>
          </>)}
          <div className="form-group mt-1"><label htmlFor="jb-notes">{t('jobs.notes')}</label><input id="jb-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={t('jobs.notesPh')} /></div>
          <div className="flex" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 18 }}>{t('jobs.total')}: {formatCurrency(total)}</strong>
            <div className="form-group" style={{ margin: 0 }}><label htmlFor="jb-dep">{t('jobs.deposit')}</label><input id="jb-dep" type="number" min="0" step="any" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} style={{ width: 120 }} /></div>
            <select aria-label={t('jobs.method')} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{['cash', 'transfer', 'card', 'other'].map((m) => <option key={m} value={m}>{t(`jobs.m_${m}`)}</option>)}</select>
            <button className="btn" type="submit">{t('jobs.createBtn')}</button>
            <button type="button" className="btn secondary" onClick={() => setForm(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
          </div>
        </form>
      )}

      <div className="card">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3>{q ? t('repair.results') : showAll ? t('jobs.allJobs') : t('jobs.openJobs')}</h3>
          <div className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="search" aria-label={t('repair.search')} placeholder={t(repair ? 'repair.searchPh' : 'repair.searchPhJobs')} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
            {repair && <ScanProductButton products={[]} onFound={() => {}} onNotFound={openByTag} />}
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t('jobs.showAll')}</label>
          </div>
        </div>
        {jobs.length === 0 ? <p className="muted">{t('jobs.none')}</p> : (
          <div style={{ overflowX: 'auto' }}><table>
            <thead><tr><th>{t('jobs.ref')}</th><th>{t('jobs.customer')}</th><th>{t('jobs.what')}</th><th>{t('jobs.due')}</th><th>{t('jobs.status')}</th><th>{t('jobs.balance')}</th><th></th></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id}>
                <td><code>{j.ref}</code>{j.tag_code && <div className="muted" style={{ fontSize: 11 }}>🏷️ {j.tag_code}</div>}</td><td>{j.customer_name}<div className="muted" style={{ fontSize: 11 }}>{j.customer_phone}</div></td>
                <td>{j.title}{itemSummary(j.item_details) && <div className="muted" style={{ fontSize: 11 }}>{itemSummary(j.item_details)}</div>}</td><td>{due(j.due_date)}</td>
                <td><span className={`badge ${j.status === 'ready' ? 'active' : j.status === 'collected' ? 'closed' : 'pending'}`}>{t(`jobs.s_${j.status}`)}</span></td>
                <td>{formatCurrency(Number(j.total) - Number(j.paid))}</td>
                <td><button className="btn small secondary" onClick={() => openJob(j.id)}>{t('jobs.open')}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {open && (
        <Modal title={`${t('jobs.job')} ${open.ref} · ${open.customer_name}`} onClose={() => setOpen(null)}>
          <p><strong>{open.title}</strong> · {t('jobs.due')}: {due(open.due_date)}{open.customer_phone && <> · {open.customer_phone}</>}</p>
          {!['collected', 'cancelled'].includes(open.status) && (
            <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {steps.map((s) => <button key={s} type="button" className={`btn small ${open.status === s ? '' : 'secondary'}`} onClick={() => act(() => api.patch(`${base}/${open.id}/status`, { status: s }))}>{t(`jobs.s_${s}`)}</button>)}
            </div>
          )}
          {open.status === 'collected' && <p>✅ {t('jobs.collectedOn', { when: new Date(open.collected_at).toLocaleString() })}</p>}
          {(repair || open.tag_code) && <RepairPanel key={open.id} job={open} base={base} onChange={setOpen} onMsg={setMsg} storeName={user.storeName} />}
          <table><tbody>{(open.items || []).map((i, n) => <tr key={n}><td>{i.description}</td><td>× {i.quantity}</td><td style={{ textAlign: 'right' }}>{formatCurrency(i.price * i.quantity)}</td></tr>)}</tbody></table>
          <p>{t('jobs.total')} <strong>{formatCurrency(open.total)}</strong> · {t('jobs.paid')} {formatCurrency(open.paid)} · {t('jobs.balance')} <strong>{formatCurrency(Number(open.total) - Number(open.paid))}</strong></p>
          {open.payments?.length > 0 && <p className="muted" style={{ fontSize: 12 }}>{open.payments.map((p) => `${t(`jobs.k_${p.kind}`)} ${formatCurrency(p.amount)} (${t(`jobs.m_${p.method}`)})`).join(' · ')}</p>}
          {Object.keys(open.measurements || {}).length > 0 && <p style={{ fontSize: 13 }}>📏 {Object.entries(open.measurements).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
          {open.materials?.length > 0 && <p style={{ fontSize: 13 }}>🧶 {open.materials.map((m) => `${m.quantity} ${m.unit} ${m.name}`).join(', ')}</p>}
          {!['collected', 'cancelled'].includes(open.status) && (<>
            {['admin', 'manager', 'staff'].includes(user.role) && (
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <select aria-label={t(repair ? 'repair.partUsed' : 'jobs.material')} value={mat.productId} onChange={(e) => setMat({ ...mat, productId: e.target.value })} style={{ flex: 1, minWidth: 150 }}>
                  <option value="">{t(repair ? 'repair.partUsed' : 'jobs.material')}</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                </select>
                <input type="number" min="0" step="any" aria-label={t('jobs.qtyUsed')} placeholder={t('jobs.qtyUsed')} value={mat.quantity} onChange={(e) => setMat({ ...mat, quantity: e.target.value })} style={{ width: 90 }} />
                <button type="button" className="btn small secondary" disabled={!mat.productId || !(Number(mat.quantity) > 0)} onClick={async () => { await act(() => api.post(`${base}/${open.id}/materials`, { productId: mat.productId, quantity: Number(mat.quantity) }), t(repair ? 'repair.partSaved' : 'jobs.materialSaved')); setMat({ productId: '', quantity: '' }); }}>{t(repair ? 'repair.usePart' : 'jobs.useMaterial')}</button>
              </div>
            )}
            <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <input type="number" min="0" step="any" aria-label={t('jobs.amount')} placeholder={t('jobs.amount')} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} style={{ width: 110 }} />
              <select aria-label={t('jobs.method')} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{['cash', 'transfer', 'card', 'other'].map((m) => <option key={m} value={m}>{t(`jobs.m_${m}`)}</option>)}</select>
              <button type="button" className="btn small secondary" disabled={!(Number(pay.amount) > 0)} onClick={async () => { await act(() => api.post(`${base}/${open.id}/payments`, { amount: Number(pay.amount), method: pay.method }), t('jobs.paymentSaved')); setPay({ amount: '', method: pay.method }); }}>{t('jobs.addPayment')}</button>
            </div>
          </>)}
          {!['collected', 'cancelled'].includes(open.status) && <TagCheck job={open} value={tagInput} onChange={setTagInput} />}
          <div className="modal-actions">
            {!['collected', 'cancelled'].includes(open.status) && (
              <button className="btn" disabled={!tagOk(open) && !canSkipTag}
                title={!tagOk(open) ? t('repair.scanFirst') : undefined}
                onClick={() => act(() => api.post(`${base}/${open.id}/collect`, { method: pay.method, tagCode: tagInput || undefined }), t('jobs.collectedMsg'))}>
                ✅ {Number(open.total) - Number(open.paid) > 0 ? t('jobs.collectPay', { amount: formatCurrency(Number(open.total) - Number(open.paid)) }) : t('jobs.collect')}
                {!tagOk(open) && canSkipTag ? ` (${t('repair.withoutTag')})` : ''}
              </button>
            )}
            <button type="button" className="btn secondary" onClick={() => printTicket(open)}>🖨️ {t('jobs.ticket')}</button>
            {!['collected', 'cancelled'].includes(open.status) && ['admin', 'manager'].includes(user.role) && <button type="button" className="btn secondary" onClick={() => act(() => api.patch(`${base}/${open.id}/status`, { status: 'cancelled' }))}>{t('jobs.cancelJob')}</button>}
            <button type="button" className="btn secondary" onClick={() => setOpen(null)}>{t('common.close', { defaultValue: 'Close' })}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

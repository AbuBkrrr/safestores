import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import api from '../api/client.js';
import ScanProductButton from './ScanProductButton.jsx';

// Repair shops (mechanics, phone/computer repair, engineering): the item the
// customer leaves, its QR tag, the diagnosis and a notes log.

const KINDS = {
  mechanic: ['Car', 'Motorcycle', 'Tricycle (keke)', 'Bus', 'Truck', 'Generator', 'Other'],
  tech_repair: ['Phone', 'Laptop', 'Tablet', 'Desktop', 'TV', 'Printer', 'Other'],
  engineering: ['Generator', 'Pump', 'Motor', 'Welding machine', 'Fridge / AC', 'Machine', 'Other'],
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The link inside the QR tag: any phone camera opens the job in the app. */
export const tagLink = (code) => `${window.location.origin}/jobs?tag=${encodeURIComponent(code)}`;

/** One-line summary of the item, e.g. "Toyota Corolla 2012 · KJA-123-AB". */
export function itemSummary(d = {}) {
  return [[d.make, d.model].filter(Boolean).join(' '), d.plate || d.serial].filter(Boolean).join(' · ');
}

/** Fields for the item left with the shop, on the new-job form. */
export function RepairIntake({ businessType, form, setForm }) {
  const { t } = useTranslation();
  const item = form.itemDetails || {};
  const setItem = (k, v) => setForm({ ...form, itemDetails: { ...item, [k]: v } });
  const car = businessType === 'mechanic';
  const field = (k, label, extra = {}) => (
    <div className="form-group" style={{ margin: 0 }}>
      <label htmlFor={`it-${k}`} style={{ fontSize: 12 }}>{label}</label>
      <input id={`it-${k}`} value={item[k] || ''} onChange={(e) => setItem(k, e.target.value)} {...extra} />
    </div>
  );
  return (
    <>
      <h4 className="mt-1">🏷️ {t('repair.itemLeft')}</h4>
      <div className="grid grid-4">
        <div className="form-group" style={{ margin: 0 }}>
          <label htmlFor="it-kind" style={{ fontSize: 12 }}>{t('repair.kind')}</label>
          <select id="it-kind" value={item.kind || ''} onChange={(e) => setItem('kind', e.target.value)}>
            <option value="">—</option>{(KINDS[businessType] || KINDS.engineering).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        {field('make', t('repair.make'), { placeholder: car ? 'Toyota' : 'Samsung' })}
        {field('model', t('repair.model'), { placeholder: car ? 'Corolla 2012' : 'Galaxy A14' })}
        {car ? field('plate', t('repair.plate'), { placeholder: 'KJA-123-AB' }) : field('serial', t('repair.serial'))}
        {car && field('serial', t('repair.vin'))}
        {car && field('mileage', t('repair.mileage'), { inputMode: 'numeric' })}
        {field('colour', t('repair.colour'))}
      </div>
      <div className="grid grid-2 mt-1">
        <div className="form-group" style={{ margin: 0 }}><label htmlFor="it-fault">{t('repair.fault')}</label>
          <textarea id="it-fault" rows={2} value={form.fault || ''} onChange={(e) => setForm({ ...form, fault: e.target.value })} placeholder={t('repair.faultPh')} /></div>
        <div className="form-group" style={{ margin: 0 }}><label htmlFor="it-cond">{t('repair.condition')}</label>
          <textarea id="it-cond" rows={2} value={form.condition || ''} onChange={(e) => setForm({ ...form, condition: e.target.value })} placeholder={t('repair.conditionPh')} /></div>
      </div>
      <div className="form-group mt-1"><label htmlFor="it-acc">{t('repair.accessories')}</label>
        <input id="it-acc" value={form.accessories || ''} onChange={(e) => setForm({ ...form, accessories: e.target.value })} placeholder={t('repair.accessoriesPh')} /></div>
      <p className="muted" style={{ fontSize: 12 }}>🔒 {t('repair.noPasscodes')}</p>
    </>
  );
}

/** Opens a printable QR tag to stick on the item. */
export async function printTag(job, storeName) {
  const w = window.open('', '_blank');
  if (!w) return;
  const qr = await QRCode.toDataURL(tagLink(job.tag_code), { width: 220, margin: 1 });
  const d = job.item_details || {};
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tag ${esc(job.tag_code)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0}.tag{width:62mm;border:1px dashed #999;padding:4mm;margin:6mm;text-align:center}
.code{font:700 20px/1.1 ui-monospace,monospace;letter-spacing:2px}.small{font-size:11px;line-height:1.35}@media print{button{display:none}.tag{border:0;margin:0}}</style></head><body>
<button onclick="window.print()" style="margin:8px">Print</button>
${[0, 1].map(() => `<div class="tag"><div class="small"><b>${esc(storeName || '')}</b></div><img src="${qr}" width="150" height="150" alt="QR">
<div class="code">${esc(job.tag_code)}</div><div class="small">Job ${esc(job.ref)} · ${esc(new Date(job.created_at || Date.now()).toLocaleDateString())}<br>
<b>${esc(job.customer_name)}</b> ${esc(job.customer_phone || '')}<br>${esc([d.kind, d.make, d.model].filter(Boolean).join(' '))}<br>${esc(d.plate || d.serial || '')}</div></div>`).join('')}
<p class="small" style="margin:6mm">Stick one tag on the item and give the other to the customer.</p></body></html>`);
  w.document.close();
}

/** Item details, diagnosis and notes inside an open repair job. */
export function RepairPanel({ job, base, onChange, onMsg, storeName }) {
  const { t } = useTranslation();
  const [diagnosis, setDiagnosis] = useState(job.diagnosis || '');
  const [note, setNote] = useState('');
  const d = job.item_details || {};
  const save = async (fn, ok) => {
    try { const r = await fn(); onChange(r.data); if (ok) onMsg({ type: 'success', text: ok }); }
    catch (err) { onMsg({ type: 'error', text: err.response?.data?.error || t('jobs.failed') }); }
  };
  const readyText = encodeURIComponent(t('repair.readyMsg', { name: job.customer_name, item: itemSummary(d) || job.title, shop: storeName || '', ref: job.ref }));
  const phone = String(job.customer_phone || '').replace(/[^\d]/g, '').replace(/^0/, '234');
  return (
    <div className="card" style={{ background: 'var(--bg-subtle, transparent)', padding: 12, marginBottom: 8 }}>
      <div className="flex" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong>🏷️ {[d.kind, d.make, d.model].filter(Boolean).join(' ') || t('repair.item')}</strong>
          <div className="muted" style={{ fontSize: 13 }}>{[d.plate && `${t('repair.plate')}: ${d.plate}`, d.serial && `${t('repair.serialShort')}: ${d.serial}`, d.colour, d.mileage && `${d.mileage} km`].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          {job.tag_code && <button type="button" className="btn small" onClick={() => printTag(job, storeName)}>🏷️ {t('repair.printTag')} <code>{job.tag_code}</code></button>}
          {job.status === 'ready' && phone && <a className="btn small secondary" target="_blank" rel="noreferrer" href={`https://wa.me/${phone}?text=${readyText}`}>💬 {t('repair.tellReady')}</a>}
        </div>
      </div>
      {job.fault && <p style={{ margin: '8px 0 0' }}><strong>{t('repair.fault')}:</strong> {job.fault}</p>}
      {job.condition_notes && <p style={{ margin: '4px 0 0' }}><strong>{t('repair.condition')}:</strong> {job.condition_notes}</p>}
      {job.accessories && <p style={{ margin: '4px 0 0' }}><strong>{t('repair.accessories')}:</strong> {job.accessories}</p>}
      <div className="form-group mt-1" style={{ marginBottom: 6 }}>
        <label htmlFor="rp-diag">{t('repair.diagnosis')}</label>
        <textarea id="rp-diag" rows={2} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} placeholder={t('repair.diagnosisPh')} />
        {diagnosis !== (job.diagnosis || '') && <button type="button" className="btn small" style={{ marginTop: 4 }} onClick={() => save(() => api.patch(`${base}/${job.id}/repair`, { diagnosis }), t('repair.saved'))}>{t('repair.saveDiagnosis')}</button>}
      </div>
      <strong style={{ fontSize: 13 }}>📝 {t('repair.notes')}</strong>
      {(job.notes_log || []).length === 0 ? <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>{t('repair.noNotes')}</p> : (
        <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
          {job.notes_log.map((n, i) => <li key={i}>{n.note} <span className="muted" style={{ fontSize: 11 }}>— {n.by || ''} {new Date(n.created_at).toLocaleString()}</span></li>)}
        </ul>
      )}
      <div className="flex" style={{ gap: 6 }}>
        <input aria-label={t('repair.addNote')} placeholder={t('repair.addNotePh')} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
        <button type="button" className="btn small secondary" disabled={!note.trim()} onClick={async () => { await save(() => api.post(`${base}/${job.id}/notes`, { note }), null); setNote(''); }}>{t('repair.addNote')}</button>
      </div>
    </div>
  );
}

/** Scan or type the tag on the item before handing it back. */
export function TagCheck({ job, value, onChange }) {
  const { t } = useTranslation();
  if (!job.tag_code) return null;
  const ok = value && value.toUpperCase().replace(/.*TAG=/, '').trim() === job.tag_code;
  return (
    <div className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <span style={{ fontSize: 13 }}>🏷️ {t('repair.scanToHandBack')}</span>
      <input aria-label={t('repair.tagCode')} placeholder="T…" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 130, textTransform: 'uppercase' }} />
      <ScanProductButton products={[]} onFound={() => {}} onNotFound={(code) => onChange(code)} />
      {value && (ok ? <span style={{ color: 'var(--success, green)' }}>✅ {t('repair.tagMatches')}</span> : <span style={{ color: 'var(--danger)' }}>⚠️ {t('repair.tagNoMatch')}</span>)}
    </div>
  );
}

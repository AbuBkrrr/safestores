import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import client from '../api/client.js';

// Escape text placed into the printable letter.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Opens a printable guarantor declaration letter, filled in for this application. */
export function openDeclarationLetter({ account, store, formatMoney }) {
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Guarantor declaration letter</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:0 24px;color:#111;line-height:1.6}
h1{font-size:20px;text-align:center;text-transform:uppercase;letter-spacing:.06em}table{width:100%;border-collapse:collapse;margin:16px 0}
td{border:1px solid #999;padding:8px;vertical-align:top}td:first-child{width:38%;font-weight:bold}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:36px}.line{border-top:1px solid #111;padding-top:4px;margin-top:48px;font-size:13px}
.seal{border:2px dashed #888;height:120px;display:grid;place-items:center;color:#888;font-size:13px;margin-top:20px}
@media print{button{display:none}}</style></head><body>
<button onclick="window.print()" style="float:right">Print</button>
<p>${esc(today)}</p>
<p>To: <strong>${esc(store?.name)}</strong><br>${esc(store?.address || '')}</p>
<h1>Guarantor declaration for credit purchases</h1>
<p>We, <strong>${esc(account.guarantor_name)}</strong>, confirm that the person named below is our ${esc(account.guarantor_kind === 'employer' ? 'staff member' : 'member/customer')}, and we guarantee payment to <strong>${esc(store?.name)}</strong> for goods they buy on credit, up to the limit stated below.</p>
<table>
<tr><td>Customer's full name</td><td>${esc(account.customer_name)}</td></tr>
<tr><td>Phone</td><td>${esc(account.customer_phone || '')}</td></tr>
<tr><td>Staff / member / account number</td><td>${esc(account.member_ref)}</td></tr>
<tr><td>Credit limit guaranteed</td><td>${esc(formatMoney(account.requested_limit))}</td></tr>
<tr><td>Application reference</td><td>${esc(String(account.id).slice(0, 8).toUpperCase())}</td></tr>
</table>
<p>We agree to settle the amounts due for these purchases when the store sends us its statement, by deduction or direct payment, and to tell the store in writing if this person leaves us or this guarantee is withdrawn.</p>
<div class="sign">
<div><div class="line">Authorised signatory (name &amp; title)</div><div class="line">Signature &amp; date</div></div>
<div><div class="line">Second signatory / witness</div><div class="seal">Official stamp / seal</div></div>
</div>
<p style="margin-top:32px;font-size:13px">Customer's signature: ____________________________ &nbsp; Date: ______________</p>
</body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

/** Customer's KYC checklist after applying: letter → upload → fee → verification. */
export default function CreditKycSteps({ storeId, token, credit, formatMoney, onChange }) {
  const { t } = useTranslation();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const a = credit.account;
  if (!a || a.status !== 'pending') return null;
  const fee = Number(credit.processingFee || 0);

  const upload = async () => {
    if (!file) return;
    setBusy(true); setMsg('');
    try {
      const fd = new FormData();
      fd.append('letter', file);
      await client.post(`/marketplace/${storeId}/credit/letter`, fd, { headers: { Authorization: `Bearer ${token}` } });
      setMsg(t('creditKyc.uploaded')); setFile(null); onChange?.();
    } catch (e) { setMsg(e.response?.data?.error || t('creditKyc.failed')); } finally { setBusy(false); }
  };

  const steps = [
    { done: true, title: t('creditKyc.s1'), body: <button type="button" className="btn small secondary" onClick={() => openDeclarationLetter({ account: a, store: credit.store, formatMoney })}>📄 {t('creditKyc.getLetter')}</button>, help: t('creditKyc.s1Help', { guarantor: a.guarantor_name }) },
    { done: !!a.letter_uploaded_at, title: t('creditKyc.s2'), help: a.letter_uploaded_at ? t('creditKyc.s2Done') : t('creditKyc.s2Help'),
      body: <span className="flex" style={{ gap: 6, flexWrap: 'wrap' }}><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-label={t('creditKyc.s2')} onChange={(e) => setFile(e.target.files[0])} />
        <button type="button" className="btn small" disabled={!file || busy} onClick={upload}>{a.letter_uploaded_at ? t('creditKyc.replace') : t('creditKyc.upload')}</button></span> },
    ...(fee > 0 ? [{ done: !!a.fee_paid_at, title: t('creditKyc.s3', { fee: formatMoney(fee) }), help: a.fee_paid_at ? t('creditKyc.s3Done') : t('creditKyc.s3Help', { store: credit.store?.name || '', phone: credit.store?.phone || '' }) }] : []),
    { done: !!a.verified_at, title: t('creditKyc.s4'), help: a.verified_at ? t('creditKyc.s4Done') : t('creditKyc.s4Help', { guarantor: a.guarantor_name }) },
  ];
  return (
    <div className="card mt-1" style={{ background: 'var(--bg)' }}>
      <strong>🤝 {t('creditKyc.title')}</strong>
      <ol style={{ paddingLeft: 18, margin: '8px 0 0', display: 'grid', gap: 10 }}>
        {steps.map((s, i) => (
          <li key={i}>
            <div style={{ fontWeight: 600 }}>{s.done ? '✅' : '⏳'} {s.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>{s.help}</div>
            {s.body && !(i === 1 && a.letter_uploaded_at && a.verified_at) && <div style={{ marginTop: 4 }}>{s.body}</div>}
          </li>
        ))}
      </ol>
      {msg && <p className="muted" role="status" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}

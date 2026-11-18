// ------------------------------------------------------------
// Receipt rendering in every format the till needs, from ONE receipt
// object (GET /orders/:id or GET /public/receipts/:token):
//   • receiptHtml()   → print window / "Save as PDF" (58 mm or 80 mm, or A4)
//   • receiptText()   → WhatsApp / SMS / plain-text download
//   • receiptEscPos() → raw bytes for ESC/POS thermal printers
//   • receiptLink()   → the shareable digital-receipt URL (QR code)
// ------------------------------------------------------------
import QRCode from 'qrcode';
import { formatCurrency } from './currency.js';

const METHOD_LABELS = { cash: 'Cash', card: 'Card', transfer: 'Transfer', mobile_money: 'Mobile money', credit: 'Credit (pay later)', other: 'Other', split: 'Split' };
export const methodLabel = (m) => METHOD_LABELS[m] || m;

export function receiptCurrency(r) {
  return { code: r.store?.currency_code, symbol: r.store?.currency_symbol };
}

export function receiptLink(r) {
  if (!r.public_token) return null;
  return `${window.location.origin}/r/${r.public_token}`;
}

function when(r) {
  const opts = { dateStyle: 'medium', timeStyle: 'short' };
  try { return new Date(r.paid_at || r.created_at).toLocaleString(undefined, { ...opts, timeZone: r.store?.timezone || undefined }); } catch { return new Date(r.paid_at).toLocaleString(); }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function totalsLines(r) {
  const c = receiptCurrency(r);
  const f = (n) => formatCurrency(n, c);
  const lines = [['Subtotal', f(r.subtotal)]];
  if (Number(r.discount_amount) > 0) lines.push([`Discount${r.discount_reason ? ` (${r.discount_reason})` : ''}`, `−${f(r.discount_amount)}`]);
  if (Number(r.tax_amount) > 0) lines.push([`${r.store?.tax_label || 'Tax'} ${Number(r.tax_rate_pct)}%${r.tax_inclusive ? ' (incl.)' : ''}`, f(r.tax_amount)]);
  lines.push(['TOTAL', f(r.total)]);
  for (const p of r.payments || []) lines.push([methodLabel(p.method), f(p.amount)]);
  if (Number(r.change_due) > 0) lines.push(['Change', f(r.change_due)]);
  if (Number(r.refunded_total) > 0) lines.push(['Refunded', `−${f(r.refunded_total)}`]);
  return lines;
}

export async function receiptHtml(r, { width = '80mm' } = {}) {
  const c = receiptCurrency(r);
  const link = receiptLink(r);
  const qr = link ? await QRCode.toDataURL(link, { margin: 0, width: 140 }) : null;
  const s = r.store || {};
  const items = (r.items || []).map((i) => `
    <tr><td colspan="2">${esc(i.product_name)}</td></tr>
    <tr><td class="muted">${i.quantity} × ${esc(formatCurrency(i.unit_price, c))}${i.refunded_qty ? ` (${i.refunded_qty} returned)` : ''}</td>
        <td class="r">${esc(formatCurrency(i.line_total, c))}</td></tr>`).join('');
  const totals = totalsLines(r).map(([k, v]) => `<tr class="${k === 'TOTAL' ? 'total' : ''}"><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(r.receipt_number)}</title>
<style>
  @page { size: ${width === 'A4' ? 'A4' : `${width} auto`}; margin: 4mm; }
  body { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: #000; margin: 0 auto; max-width: ${width === 'A4' ? '160mm' : width}; }
  h1 { font-size: 15px; text-align: center; margin: 4px 0; }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; } .muted { color: #444; }
  table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  .total td { font-weight: 700; font-size: 14px; border-top: 1px dashed #000; padding-top: 4px; }
  img.qr { display: block; margin: 8px auto 2px; width: 30mm; height: 30mm; }
</style></head><body>
  <h1>${esc(s.name || 'Receipt')}</h1>
  ${s.receipt_header ? `<div class="c">${esc(s.receipt_header)}</div>` : ''}
  <div class="c muted">${esc([s.address, s.city].filter(Boolean).join(', '))}${s.phone ? `<br>${esc(s.phone)}` : ''}${s.tax_number ? `<br>${esc(s.tax_label || 'Tax')} No: ${esc(s.tax_number)}` : ''}</div>
  <div class="sep"></div>
  <div>Receipt: ${esc(r.receipt_number)}<br>${esc(when(r))}${r.cashier_name ? `<br>Served by: ${esc(r.cashier_name)}` : ''}</div>
  <div class="sep"></div>
  <table>${items}</table>
  <div class="sep"></div>
  <table>${totals}</table>
  ${s.receipt_footer ? `<div class="sep"></div><div class="c">${esc(s.receipt_footer)}</div>` : ''}
  ${qr ? `<img class="qr" src="${qr}" alt=""><div class="c muted">Scan for your digital receipt</div>` : ''}
  <div class="c muted" style="margin-top:6px">Thank you!</div>
</body></html>`;
}

export async function printReceipt(r, opts) {
  const html = await receiptHtml(r, opts);
  const win = window.open('', '_blank', 'width=420,height=700');
  if (!win) return false; // popup blocked
  win.document.write(html);
  win.document.close();
  win.focus();
  // Wait for the QR image before printing.
  setTimeout(() => win.print(), 300);
  return true;
}

export function receiptText(r) {
  const c = receiptCurrency(r);
  const s = r.store || {};
  const lines = [
    `*${s.name || 'Receipt'}*`,
    `Receipt ${r.receipt_number} · ${when(r)}`,
    '',
    ...(r.items || []).map((i) => `${i.product_name} × ${i.quantity} — ${formatCurrency(i.line_total, c)}`),
    '',
    ...totalsLines(r).map(([k, v]) => `${k}: ${v}`),
  ];
  if (s.receipt_footer) lines.push('', s.receipt_footer);
  const link = receiptLink(r);
  if (link) lines.push('', `View receipt: ${link}`);
  return lines.join('\n');
}

export function whatsappReceiptUrl(r, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(receiptText(r))}`;
}

export function downloadReceiptText(r) {
  const blob = new Blob([receiptText(r).replace(/\*/g, '')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `receipt-${r.receipt_number}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- ESC/POS (thermal printers) ----------------
// Plain, widely supported commands only: init, align, bold, double height,
// feed and partial cut. Text is sent as ASCII with common symbols spelt
// out, because most cheap printers have no Unicode code page.
const ESC = 0x1b; const GS = 0x1d;

function ascii(s) {
  return String(s ?? '')
    .replace(/[₦]/g, 'N').replace(/[€]/g, 'EUR').replace(/[£]/g, 'GBP').replace(/[₵]/g, 'C').replace(/[−–—]/g, '-').replace(/[×]/g, 'x')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '?');
}

export function receiptEscPos(r, { columns = 32 } = {}) {
  const out = [];
  const push = (...b) => out.push(...b);
  const text = (s) => { for (const ch of ascii(s)) out.push(ch.charCodeAt(0)); };
  const line = (s = '') => { text(s); push(0x0a); };
  const pair = (l, rr) => {
    const left = ascii(l); const right = ascii(rr);
    const space = Math.max(1, columns - left.length - right.length);
    if (left.length + right.length + 1 > columns) { line(left); line(right.padStart(columns)); } else line(left + ' '.repeat(space) + right);
  };
  const c = receiptCurrency(r);
  const s = r.store || {};
  push(ESC, 0x40);                     // init
  push(ESC, 0x61, 1);                  // center
  push(ESC, 0x45, 1, GS, 0x21, 0x01);  // bold + double height
  line(s.name || 'RECEIPT');
  push(ESC, 0x45, 0, GS, 0x21, 0x00);
  if (s.receipt_header) line(s.receipt_header);
  if (s.address || s.city) line([s.address, s.city].filter(Boolean).join(', '));
  if (s.phone) line(s.phone);
  if (s.tax_number) line(`${s.tax_label || 'Tax'} No: ${s.tax_number}`);
  push(ESC, 0x61, 0);                  // left
  line('-'.repeat(columns));
  line(`Receipt: ${r.receipt_number}`);
  line(when(r));
  if (r.cashier_name) line(`Served by: ${r.cashier_name}`);
  line('-'.repeat(columns));
  for (const i of r.items || []) {
    line(i.product_name);
    pair(`  ${i.quantity} x ${formatCurrency(i.unit_price, c)}`, formatCurrency(i.line_total, c));
  }
  line('-'.repeat(columns));
  for (const [k, v] of totalsLines(r)) {
    if (k === 'TOTAL') { push(ESC, 0x45, 1); pair(k, v); push(ESC, 0x45, 0); } else pair(k, v);
  }
  if (s.receipt_footer) { line('-'.repeat(columns)); push(ESC, 0x61, 1); line(s.receipt_footer); push(ESC, 0x61, 0); }
  push(ESC, 0x61, 1); line('Thank you!'); push(ESC, 0x61, 0);
  push(0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00); // feed + partial cut
  return new Uint8Array(out);
}

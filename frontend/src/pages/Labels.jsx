import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import JsBarcode from 'jsbarcode';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SIZES = {
  shelf: { label: 'Shelf edge (60 × 30 mm)', w: 60, h: 30, perRow: 3 },
  small: { label: 'Small sticker (38 × 25 mm)', w: 38, h: 25, perRow: 5 },
  large: { label: 'Large (100 × 50 mm)', w: 100, h: 50, perRow: 2 },
};

/** EAN-13 check digit. */
function ean13Check(d12) {
  const sum = d12.split('').reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}
/** In-store EAN-13 (GS1 prefix 2xx is reserved for internal use, so it never clashes with a manufacturer code). */
export function makeInStoreBarcode() {
  const body = `2${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
  return body + ean13Check(body);
}

function svgFor(code) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const format = /^\d{13}$/.test(code) && ean13Check(code.slice(0, 12)) === code[12] ? 'EAN13' : 'CODE128';
  try {
    JsBarcode(svg, code, { format, height: 40, fontSize: 12, margin: 0, displayValue: true });
  } catch {
    JsBarcode(svg, code, { format: 'CODE128', height: 40, fontSize: 12, margin: 0 });
  }
  return svg.outerHTML;
}

/** Print shelf-edge price labels and barcode stickers. */
export default function Labels() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [products, setProducts] = useState([]);
  const [qty, setQty] = useState({});
  const [size, setSize] = useState('shelf');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/products`).then((r) => setProducts((r.data || []).filter((p) => !p.archived_at)));
  useEffect(() => { load(); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => !q || [p.name, p.sku, p.barcode].some((v) => v && String(v).toLowerCase().includes(q)));
  }, [products, query]);

  const missingBarcode = products.filter((p) => !p.barcode);
  const canEdit = ['admin', 'manager'].includes(user.role);

  const generateBarcodes = async () => {
    setError('');
    try {
      for (const p of missingBarcode) {
        // eslint-disable-next-line no-await-in-loop
        await api.put(`/stores/${user.storeId}/products/${p.id}`, { barcode: makeInStoreBarcode() });
      }
      showToast(t('labelsPage.generated', { count: missingBarcode.length }), 'success');
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
  };

  const print = () => {
    const s = SIZES[size];
    const labels = [];
    for (const p of products) {
      const n = Number(qty[p.id]) || 0;
      const code = p.barcode || p.sku;
      for (let i = 0; i < n; i++) {
        labels.push(`<div class="lbl"><div class="name">${escapeHtml(p.name)}${p.variant_label ? ` · ${escapeHtml(p.variant_label)}` : ''}</div>
          <div class="price">${escapeHtml(formatCurrency(p.selling_price ?? Number(p.cost_price) * Number(p.price_multiplier)))}</div>
          <div class="bc">${svgFor(code)}</div></div>`);
      }
    }
    if (!labels.length) { setError(t('labelsPage.pickSome')); return; }
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
      @page { margin: 6mm; } body { margin: 0; font-family: Arial, sans-serif; }
      .sheet { display: grid; grid-template-columns: repeat(${s.perRow}, ${s.w}mm); gap: 2mm; }
      .lbl { width: ${s.w}mm; height: ${s.h}mm; border: 0.2mm dashed #bbb; padding: 1.5mm; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; break-inside: avoid; }
      .name { font-size: ${s.h > 30 ? 12 : 8}pt; font-weight: 600; line-height: 1.1; max-height: 2.3em; overflow: hidden; }
      .price { font-size: ${s.h > 30 ? 20 : 11}pt; font-weight: 800; }
      .bc { flex: 1; display: flex; align-items: flex-end; } .bc svg { width: 100%; height: auto; max-height: ${Math.round(s.h * 0.45)}mm; }
    </style></head><body><div class="sheet">${labels.join('')}</div></body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 300);
  };

  return (
    <div>
      <div className="topbar"><div><h1>{t('labelsPage.title')}</h1><p className="muted">{t('labelsPage.subtitle')}</p></div></div>
      <Alert type="error">{error}</Alert>
      {canEdit && missingBarcode.length > 0 && (
        <Alert type="info">{t('labelsPage.missing', { count: missingBarcode.length })} <button className="btn small secondary" onClick={generateBarcodes}>{t('labelsPage.generate')}</button></Alert>
      )}
      <div className="card">
        <div className="flex">
          <input aria-label={t('common.search')} placeholder={t('products.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 260 }} />
          <select aria-label={t('labelsPage.size')} value={size} onChange={(e) => setSize(e.target.value)} style={{ maxWidth: 260 }}>
            {Object.entries(SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn small secondary" onClick={() => setQty(Object.fromEntries(visible.map((p) => [p.id, 1])))}>{t('labelsPage.oneEach')}</button>
          <button className="btn" onClick={print}>🖨️ {t('labelsPage.print')}</button>
        </div>
        <div className="table-wrap mt-1">
          <table>
            <thead><tr><th>{t('products.name')}</th><th>{t('products.barcode')}</th><th>{t('products.sellPrice')}</th><th>{t('labelsPage.copies')}</th></tr></thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}{p.variant_label ? <span className="muted"> · {p.variant_label}</span> : null}</td>
                  <td><code>{p.barcode || p.sku}</code></td>
                  <td>{formatCurrency(p.selling_price ?? Number(p.cost_price) * Number(p.price_multiplier))}</td>
                  <td><input aria-label={`${t('labelsPage.copies')} ${p.name}`} type="number" min="0" value={qty[p.id] || ''} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value })} style={{ width: 70 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { formatCurrency } from '../utils/currency.js';
import {
  methodLabel, printReceipt, receiptEscPos, receiptLink, receiptCurrency, whatsappReceiptUrl, downloadReceiptText,
} from '../utils/receipt.js';
import { printRaw, printerSupport, savedPrinterType, savePrinterType } from '../utils/printer.js';

/** On-screen receipt + every way to hand it to the customer. */
export default function ReceiptView({ receipt, publicView = false, onToast }) {
  const { t } = useTranslation();
  const [qr, setQr] = useState(null);
  const [phone, setPhone] = useState('');
  const [printerType, setPrinterType] = useState(savedPrinterType());
  const support = printerSupport();
  const c = receiptCurrency(receipt);
  const f = (n) => formatCurrency(n, c);
  const link = receiptLink(receipt);
  const toast = (m, type = 'success') => onToast?.(m, type);

  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 1, width: 160 }).then(setQr).catch(() => setQr(null));
  }, [link]);

  const thermal = async (ask = false) => {
    try {
      await printRaw(receiptEscPos(receipt, { columns: 32 }), printerType, { ask });
      toast(t('receipt.sentToPrinter'));
    } catch (err) {
      toast(err.message || t('receipt.printerFailed'), 'error');
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); toast(t('receipt.linkCopied')); } catch { toast(link, 'info'); }
  };

  const share = async () => {
    try { await navigator.share({ title: `${receipt.store?.name || ''} receipt`, url: link }); } catch { /* user cancelled */ }
  };

  const s = receipt.store || {};
  return (
    <div className="card receipt-card" style={{ maxWidth: 520 }}>
      <div style={{ textAlign: 'center' }}>
        <h3 style={{ marginBottom: 2 }}>{s.name}</h3>
        {s.receipt_header && <p className="muted">{s.receipt_header}</p>}
        {(s.address || s.city) && <p className="muted">{[s.address, s.city].filter(Boolean).join(', ')}</p>}
      </div>
      <h3 className="mt-1">{t('checkout.receiptHeading', { number: receipt.receipt_number })}</h3>
      <p className="muted">{new Date(receipt.paid_at).toLocaleString()} {receipt.cashier_name ? `· ${receipt.cashier_name}` : ''}</p>
      <div className="mt-1">
        {(receipt.items || []).map((i, idx) => (
          <div key={i.id || idx} className="flex-between" style={{ padding: '4px 0' }}>
            <span>{i.product_name} × {i.quantity}{i.refunded_qty ? <span className="muted"> ({t('receipt.returned', { count: i.refunded_qty })})</span> : null}</span>
            <span>{f(i.line_total)}</span>
          </div>
        ))}
      </div>
      <div className="receipt-totals mt-1">
        {receipt.subtotal != null && Number(receipt.subtotal) !== Number(receipt.total) && <div className="flex-between"><span>{t('receipt.subtotal')}</span><span>{f(receipt.subtotal)}</span></div>}
        {Number(receipt.discount_amount) > 0 && <div className="flex-between"><span>{t('receipt.discount')}{receipt.discount_reason ? ` (${receipt.discount_reason})` : ''}</span><span>−{f(receipt.discount_amount)}</span></div>}
        {Number(receipt.tax_amount) > 0 && <div className="flex-between"><span>{s.tax_label || t('receipt.tax')} {Number(receipt.tax_rate_pct)}%{receipt.tax_inclusive ? ` ${t('receipt.inclusive')}` : ''}</span><span>{f(receipt.tax_amount)}</span></div>}
        <div className="flex-between" style={{ fontSize: 22, fontWeight: 700 }}><span>{t('checkout.total')}</span><span>{f(receipt.total)}</span></div>
        {(receipt.payments || []).map((p, idx) => (
          <div key={idx} className="flex-between muted"><span>{methodLabel(p.method)}</span><span>{f(p.amount)}</span></div>
        ))}
        {Number(receipt.change_due) > 0 && <div className="flex-between" style={{ fontWeight: 600 }}><span>{t('receipt.change')}</span><span>{f(receipt.change_due)}</span></div>}
        {Number(receipt.refunded_total) > 0 && <div className="flex-between" style={{ color: 'var(--danger)' }}><span>{t('receipt.refunded')}</span><span>−{f(receipt.refunded_total)}</span></div>}
      </div>
      {s.receipt_footer && <p className="muted mt-1" style={{ textAlign: 'center' }}>{s.receipt_footer}</p>}
      {qr && !publicView && <div style={{ textAlign: 'center' }} className="mt-1"><img src={qr} alt={t('receipt.qrAlt')} width={140} height={140} /><p className="muted">{t('receipt.scanForDigital')}</p></div>}

      {!publicView && (
        <>
          <div className="flex mt-1">
            <button className="btn secondary small" onClick={() => printReceipt(receipt, { width: '80mm' })}>{t('checkout.print')}</button>
            <button className="btn secondary small" onClick={() => printReceipt(receipt, { width: 'A4' })}>📄 {t('receipt.pdf')}</button>
            <button className="btn secondary small" onClick={() => downloadReceiptText(receipt)}>{t('checkout.download')}</button>
            {link && <button className="btn secondary small" onClick={copyLink}>🔗 {t('receipt.copyLink')}</button>}
            {link && typeof navigator !== 'undefined' && navigator.share && <button className="btn secondary small" onClick={share}>📤 {t('receipt.share')}</button>}
          </div>
          <div className="flex mt-1">
            <input aria-label={t('receipt.customerPhone')} placeholder={t('receipt.customerPhonePlaceholder')} value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 200 }} inputMode="tel" />
            <a className="btn small" style={{ background: '#25D366', textDecoration: 'none' }} href={whatsappReceiptUrl(receipt, phone)} target="_blank" rel="noreferrer">WhatsApp</a>
          </div>
          {(support.serial || support.usb || support.bluetooth) && (
            <div className="flex mt-1">
              <select aria-label={t('receipt.printerType')} value={printerType} onChange={(e) => { setPrinterType(e.target.value); savePrinterType(e.target.value); }} style={{ maxWidth: 220 }}>
                <option value="">{t('receipt.thermalChoose')}</option>
                {support.serial && <option value="serial">USB / Serial</option>}
                {support.usb && <option value="usb">USB (raw)</option>}
                {support.bluetooth && <option value="bluetooth">Bluetooth</option>}
              </select>
              {printerType && <button className="btn small secondary" onClick={() => thermal(false)}>🧾 {t('receipt.thermalPrint')}</button>}
              {printerType && <button className="btn small secondary" onClick={() => thermal(true)}>{t('receipt.thermalPick')}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

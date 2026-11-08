import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { formatCurrency as formatMoney } from '../utils/currency.js';

const SYNC_EVENTS = ['order:updated', 'order:paid', 'order:cancelled'];
const CAN_TAKE_PAYMENT = ['admin', 'manager', 'cashier'];

// These two build a print/download receipt outside any component, so they
// take the currency symbol as a parameter rather than using the
// useCurrency() hook (hooks only work inside component bodies).
function downloadReceipt(receipt, currency) {
  const lines = [
    'SAFE STORES — RECEIPT',
    `Receipt #: ${receipt.receipt_number}`,
    `Date: ${new Date(receipt.paid_at).toLocaleString()}`,
    `Payment method: ${receipt.payment_method}`,
    '',
    'Items:',
    ...(receipt.items || []).map((i) => `  ${i.product_name} x${i.quantity} .......... ${formatMoney(i.line_total, currency)}`),
    '',
    `TOTAL: ${formatMoney(receipt.total, currency)}`,
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.setAttribute('download', `receipt-${receipt.receipt_number}.txt`);
  document.body.appendChild(link); link.click(); link.remove();
  window.URL.revokeObjectURL(url);
}

function printReceipt(receipt, currency) {
  const win = window.open('', '_blank', 'width=380,height=600');
  const itemRows = (receipt.items || [])
    .map((i) => `<tr><td>${i.product_name} x${i.quantity}</td><td style="text-align:right">${formatMoney(i.line_total, currency)}</td></tr>`)
    .join('');
  win.document.write(`
    <html><head><title>Receipt ${receipt.receipt_number}</title>
    <style>body{font-family:monospace;padding:16px;font-size:13px} table{width:100%;border-collapse:collapse} td{padding:4px 0} .total{font-weight:bold;border-top:1px dashed #000;padding-top:8px}</style>
    </head><body>
      <h3 style="text-align:center">SAFE STORES</h3>
      <p>Receipt #: ${receipt.receipt_number}<br/>Date: ${new Date(receipt.paid_at).toLocaleString()}<br/>Method: ${receipt.payment_method}</p>
      <table>${itemRows}</table>
      <p class="total">TOTAL: ${formatMoney(receipt.total, currency)}</p>
    </body></html>
  `);
  win.document.close();
  win.focus();
  win.print();
}

export default function Checkout() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { currency, formatCurrency } = useCurrency();
  const canPay = CAN_TAKE_PAYMENT.includes(user.role);
  const [pending, setPending] = useState([]);
  const [order, setOrder] = useState(null);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [customers, setCustomers] = useState([]);
  const [creditCustomerId, setCreditCustomerId] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const videoRef = useRef();
  const readerRef = useRef();

  const loadPending = () => api.get(`/stores/${user.storeId}/orders`, { params: { status: 'pending_payment' } }).then((r) => setPending(r.data));
  useEffect(() => {
    loadPending();
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
  }, [user.storeId]);
  useRealtimeEvents(SYNC_EVENTS, () => { loadPending(); if (order) refreshOrder(order.id); });

  useEffect(() => {
    if (paymentMethod === 'credit' && customers.length === 0) {
      api.get(`/stores/${user.storeId}/customers`).then((r) => setCustomers(r.data)).catch(() => setCustomers([]));
    }
  }, [paymentMethod, user.storeId]);

  const refreshOrder = (orderId) => api.get(`/stores/${user.storeId}/orders/${orderId}`).then((r) => setOrder(r.data));

  const startOrder = async () => {
    const { data } = await api.post(`/stores/${user.storeId}/orders`, {});
    setOrder({ ...data, items: [] });
    setReceipt(null);
    loadPending();
  };

  const pickUp = (orderId) => refreshOrder(orderId).then(() => setReceipt(null));

  const addProduct = async (productId, addedVia = 'manual_search') => {
    if (!order) return;
    setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/orders/${order.id}/items`, { productId, quantity: 1, addedVia });
      setOrder(data.order);
      refreshOrder(order.id);
      setSearch('');
    } catch (err) {
      setError(err.response?.data?.error || t('checkout.addItemError'));
    }
  };

  const removeItem = async (itemId) => {
    const { data } = await api.delete(`/stores/${user.storeId}/orders/${order.id}/items/${itemId}`);
    setOrder(data);
    refreshOrder(order.id);
  };

  const pay = async () => {
    if (paymentMethod === 'credit' && !creditCustomerId) {
      setError(t('checkout.selectCustomerError'));
      return;
    }
    setError('');
    const { data } = await api.post(`/stores/${user.storeId}/orders/${order.id}/pay`, {
      paymentMethod, storeCustomerId: paymentMethod === 'credit' ? creditCustomerId : undefined,
    });
    const full = await api.get(`/stores/${user.storeId}/orders/${data.id}`);
    setReceipt(full.data);
    setOrder(null);
    setPaymentMethod('cash');
    setCreditCustomerId('');
    loadPending();
    showToast(t('checkout.paymentConfirmedToast'), 'success');
  };

  const cancelOrder = async () => {
    if (!confirm(t('checkout.cancelConfirm'))) return;
    await api.post(`/stores/${user.storeId}/orders/${order.id}/cancel`);
    setOrder(null);
    loadPending();
  };

  // Live barcode scanning, same approach as the Camera page
  useEffect(() => {
    if (!scanning || !videoRef.current) return undefined;
    let stream;
    const codeReader = new BrowserMultiFormatReader();
    readerRef.current = codeReader;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      videoRef.current.srcObject = s;
      codeReader.decodeFromVideoElement(videoRef.current, async (result) => {
        if (!result) return;
        const code = result.getText();
        try {
          const { data } = await api.get(`/stores/${user.storeId}/barcode-lookup`, { params: { code } });
          addProduct(data.id, 'scan');
        } catch { /* no match — ignore this frame */ }
      });
    }).catch(() => setError(t('checkout.cameraError')));
    return () => { codeReader.reset(); stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  const filteredProducts = search.length > 0
    ? products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()))
    : [];

  if (receipt) {
    return (
      <div>
        <div className="topbar"><h1>{t('checkout.receiptTitle')}</h1></div>
        <div className="card" style={{ maxWidth: 480 }}>
          <h3>{t('checkout.receiptHeading', { number: receipt.receipt_number })}</h3>
          <p className="muted">{t('checkout.paidVia', { method: receipt.payment_method, date: new Date(receipt.paid_at).toLocaleString() })}</p>
          {(receipt.items || []).map((i) => (
            <div key={i.id} className="flex" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{i.product_name} × {i.quantity}</span><span>{formatCurrency(i.line_total)}</span>
            </div>
          ))}
          <p style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>{formatCurrency(receipt.total)}</p>
          <div className="flex mt-1">
            <button className="btn secondary" onClick={() => downloadReceipt(receipt, currency)}>{t('checkout.download')}</button>
            <button className="btn secondary" onClick={() => printReceipt(receipt, currency)}>{t('checkout.print')}</button>
          </div>
          <button className="btn mt-1" onClick={() => setReceipt(null)}>{t('checkout.newOrder')}</button>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <div className="topbar"><h1>{t('checkout.title')}</h1></div>
        <div className="card">
          <button className="btn" onClick={startOrder}>{t('checkout.startNewOrder')}</button>
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('checkout.pendingOrders')} {canPay ? t('checkout.pendingOrdersHint') : ''}</h3>
          {pending.length === 0 && <p className="muted">{t('checkout.noPendingOrders')}</p>}
          {pending.map((o) => (
            <div key={o.id} className="flex" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
              <span>{t('checkout.orderStartedBy', { name: o.created_by_name || t('checkout.someone') })} · {formatCurrency(o.total)}</span>
              <button className="btn small" onClick={() => pickUp(o.id)}>{t('checkout.open')}</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar"><h1>{t('checkout.titleInProgress')}</h1></div>
      <Alert type="error">{error}</Alert>

      <div className="grid grid-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('checkout.addItems')}</h3>
          <div className="flex">
            <button className={`btn ${scanning ? 'secondary' : ''} small`} onClick={() => setScanning((s) => !s)}>
              {scanning ? t('checkout.stopScanning') : t('checkout.scanBarcode')}
            </button>
          </div>
          {scanning && <video ref={videoRef} autoPlay playsInline style={{ width: '100%', marginTop: 8, borderRadius: 8, background: '#000', maxHeight: 200, objectFit: 'cover' }} />}

          <div className="form-group mt-1">
            <label>{t('checkout.searchLabel')}</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('checkout.searchPlaceholder')} />
          </div>
          {filteredProducts.length > 0 && (
            <div className="card" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {filteredProducts.map((p) => (
                <div key={p.id} className="flex" style={{ justifyContent: 'space-between', padding: '6px 0', cursor: 'pointer' }} onClick={() => addProduct(p.id, 'manual_search')}>
                  <span>{p.name} ({p.sku})</span>
                  <span className="muted">{t('checkout.shelf', { qty: p.shelf_qty })}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('checkout.orderItems')}</h3>
          {(!order.items || order.items.length === 0) && <p className="muted">{t('checkout.noItemsYet')}</p>}
          {order.items?.map((item) => (
            <div key={item.id} className="flex" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span>{item.product_name} × {item.quantity}</span>
              <span>{formatCurrency(item.line_total)} <button className="btn danger small" onClick={() => removeItem(item.id)}>✕</button></span>
            </div>
          ))}
          <div className="flex mt-1" style={{ justifyContent: 'space-between', fontWeight: 700, fontSize: 18 }}>
            <span>{t('checkout.total')}</span><span>{formatCurrency(order.total || 0)}</span>
          </div>

          {canPay ? (
            <div className="mt-1">
              <div className="form-group">
                <label htmlFor="payment-method">{t('checkout.paymentMethod')}</label>
                <select id="payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="cash">{t('checkout.cash')}</option>
                  <option value="card">{t('checkout.card')}</option>
                  <option value="transfer">{t('checkout.transfer')}</option>
                  <option value="credit">{t('checkout.credit')}</option>
                  <option value="other">{t('checkout.other')}</option>
                </select>
              </div>
              {paymentMethod === 'credit' && (
                <div className="form-group">
                  <label htmlFor="credit-customer">{t('checkout.customer')}</label>
                  <select id="credit-customer" value={creditCustomerId} onChange={(e) => setCreditCustomerId(e.target.value)}>
                    <option value="">{t('checkout.selectCustomer')}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>
                    ))}
                  </select>
                  <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {t('checkout.noCustomerYet')} <a href="/customers">{t('checkout.customersLabel')}</a> {t('checkout.pageFirst')}
                  </p>
                </div>
              )}
              <button className="btn" onClick={pay} disabled={!order.items?.length}>{t('checkout.confirmPayment')}</button>
            </div>
          ) : (
            <p className="muted mt-1">{t('checkout.readyForCashier')}</p>
          )}
          <button className="btn secondary small mt-1" onClick={cancelOrder}>{t('checkout.cancelOrder')}</button>
        </div>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { Alert, Modal, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';
import ReceiptView from '../components/ReceiptView.jsx';

const SYNC_EVENTS = ['order:updated', 'order:paid', 'order:cancelled'];
const CAN_TAKE_PAYMENT = ['admin', 'manager', 'cashier'];
const TILL_ROLES = ['admin', 'manager', 'cashier', 'checkout'];
const METHODS = ['cash', 'card', 'transfer', 'mobile_money', 'credit', 'other'];

export default function Checkout() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const canPay = CAN_TAKE_PAYMENT.includes(user.role);
  const usesShifts = TILL_ROLES.includes(user.role);
  const [pending, setPending] = useState([]);
  const [order, setOrder] = useState(null);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [received, setReceived] = useState('');
  const [splitMode, setSplitMode] = useState(false);
  const [splits, setSplits] = useState([{ method: 'cash', amount: '' }, { method: 'card', amount: '' }]);
  const [customers, setCustomers] = useState([]);
  const [creditCustomerId, setCreditCustomerId] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [toast, showToast] = useToast();
  const [shift, setShift] = useState(null);
  const [shiftModal, setShiftModal] = useState(null); // 'open' | 'close'
  const [shiftForm, setShiftForm] = useState({ amount: '', notes: '' });
  const [discountModal, setDiscountModal] = useState(false);
  const [discount, setDiscount] = useState({ type: 'percent', value: '', reason: '', approverEmail: '', approverPassword: '', needsApproval: false });
  const videoRef = useRef();
  const readerRef = useRef();
  const searchRef = useRef();
  const payRef = useRef();

  const loadPending = () => api.get(`/stores/${user.storeId}/orders`, { params: { status: 'pending_payment' } }).then((r) => setPending(Array.isArray(r.data) ? r.data : []));
  const loadShift = () => usesShifts && api.get(`/stores/${user.storeId}/shifts/current`).then((r) => setShift(r.data?.id ? r.data : null)).catch(() => {});
  useEffect(() => {
    loadPending();
    loadShift();
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(Array.isArray(r.data) ? r.data : []));
  }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeEvents(SYNC_EVENTS, () => { loadPending(); if (order) refreshOrder(order.id); });

  useEffect(() => {
    const needsCustomers = paymentMethod === 'credit' || (splitMode && splits.some((s) => s.method === 'credit'));
    if (needsCustomers && customers.length === 0) {
      api.get(`/stores/${user.storeId}/customers`).then((r) => setCustomers(r.data)).catch(() => setCustomers([]));
    }
  }, [paymentMethod, splitMode, splits, user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Till keyboard shortcuts: F2 = search, F4 = pay, Esc = clear search.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); payRef.current?.focus(); payRef.current?.click(); }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) setSearch('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshOrder = (orderId) => api.get(`/stores/${user.storeId}/orders/${orderId}`).then((r) => setOrder(r.data));

  const resetPayment = () => {
    setPaymentMethod('cash'); setCreditCustomerId(''); setReceived(''); setSplitMode(false);
    setSplits([{ method: 'cash', amount: '' }, { method: 'card', amount: '' }]);
  };

  const startOrder = async () => {
    const { data } = await api.post(`/stores/${user.storeId}/orders`, {});
    setOrder({ ...data, items: [] });
    setReceipt(null);
    resetPayment();
    loadPending();
    setTimeout(() => searchRef.current?.focus(), 0);
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

  // A USB/Bluetooth barcode scanner "types" the code and presses Enter.
  const onSearchKey = async (e) => {
    if (e.key !== 'Enter' || !search.trim()) return;
    e.preventDefault();
    const code = search.trim();
    const exact = products.find((p) => p.sku?.toLowerCase() === code.toLowerCase() || p.barcode === code);
    if (exact) return addProduct(exact.id, 'scan');
    try {
      const { data } = await api.get(`/stores/${user.storeId}/barcode-lookup`, { params: { code } });
      if (data?.id) return addProduct(data.id, 'scan');
    } catch { /* not a barcode — fall back to the first name match */ }
    if (filteredProducts.length === 1) addProduct(filteredProducts[0].id, 'manual_search');
  };

  const removeItem = async (itemId) => {
    const { data } = await api.delete(`/stores/${user.storeId}/orders/${order.id}/items/${itemId}`);
    setOrder(data);
    refreshOrder(order.id);
  };

  const total = Number(order?.total || 0);
  const splitTotal = splits.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const changeDue = splitMode
    ? Math.max(0, splitTotal - total)
    : (paymentMethod === 'cash' && Number(received) > 0 ? Math.max(0, Number(received) - total) : 0);

  const pay = async () => {
    const usesCredit = splitMode ? splits.some((s) => s.method === 'credit' && Number(s.amount) > 0) : paymentMethod === 'credit';
    if (usesCredit && !creditCustomerId) {
      setError(t('checkout.selectCustomerError'));
      return;
    }
    if (paymentMethod === 'cash' && !splitMode && received !== '' && Number(received) < total) {
      setError(t('checkout.receivedTooLow'));
      return;
    }
    setError('');
    let body;
    if (splitMode) {
      body = { payments: splits.filter((s) => Number(s.amount) > 0).map((s) => ({ method: s.method, amount: Number(s.amount) })), storeCustomerId: usesCredit ? creditCustomerId : undefined };
    } else if (paymentMethod === 'cash' && Number(received) > 0) {
      body = { payments: [{ method: 'cash', amount: Number(received) }] };
    } else {
      body = { paymentMethod, storeCustomerId: paymentMethod === 'credit' ? creditCustomerId : undefined };
    }
    try {
      const { data } = await api.post(`/stores/${user.storeId}/orders/${order.id}/pay`, body);
      const full = await api.get(`/stores/${user.storeId}/orders/${data.id}`);
      setReceipt(full.data);
      setOrder(null);
      resetPayment();
      loadPending();
      showToast(t('checkout.paymentConfirmedToast'), 'success');
    } catch (err) {
      if (err.response?.data?.code === 'SHIFT_REQUIRED') setShiftModal('open');
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
  };

  const cancelOrder = async () => {
    if (!confirm(t('checkout.cancelConfirm'))) return;
    await api.post(`/stores/${user.storeId}/orders/${order.id}/cancel`);
    setOrder(null);
    loadPending();
  };

  const parkOrder = async () => {
    const label = prompt(t('checkout.parkPrompt'), order.parked_label || '');
    if (label === null) return;
    await api.patch(`/stores/${user.storeId}/orders/${order.id}/park`, { label: label || t('checkout.parkedDefault') });
    setOrder(null);
    loadPending();
    showToast(t('checkout.parkedToast'), 'success');
  };

  const submitDiscount = async (e) => {
    e?.preventDefault();
    setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/orders/${order.id}/discount`, {
        type: discount.type, value: Number(discount.value), reason: discount.reason || undefined,
        approverEmail: discount.needsApproval ? discount.approverEmail : undefined,
        approverPassword: discount.needsApproval ? discount.approverPassword : undefined,
      });
      setOrder((o) => ({ ...o, ...data }));
      setDiscountModal(false);
      setDiscount({ type: 'percent', value: '', reason: '', approverEmail: '', approverPassword: '', needsApproval: false });
    } catch (err) {
      if (err.response?.data?.code === 'DISCOUNT_APPROVAL_REQUIRED') setDiscount((d) => ({ ...d, needsApproval: true }));
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
  };

  const removeDiscount = async () => {
    const { data } = await api.post(`/stores/${user.storeId}/orders/${order.id}/discount`, { type: null });
    setOrder((o) => ({ ...o, ...data }));
  };

  const submitShift = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (shiftModal === 'open') {
        await api.post(`/stores/${user.storeId}/shifts`, { openingFloat: Number(shiftForm.amount) || 0 });
        showToast(t('shift.openedToast'), 'success');
      } else {
        const { data } = await api.post(`/stores/${user.storeId}/shifts/${shift.id}/close`, { countedCash: Number(shiftForm.amount), notes: shiftForm.notes || undefined });
        showToast(t('shift.closedToast', { variance: formatCurrency(data.variance) }), Math.abs(data.variance) < 0.01 ? 'success' : 'warning');
      }
      setShiftModal(null);
      setShiftForm({ amount: '', notes: '' });
      loadShift();
    } catch (err) {
      setError(err.response?.data?.error || t('common.errorGeneric'));
    }
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
    return () => { codeReader.reset(); stream?.getTracks().forEach((tr) => tr.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  const filteredProducts = search.length > 0
    ? products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()))
    : [];
  // Quick-pick grid: the store's best sellers that are on the shelf.
  const quickPicks = useMemo(() => [...products]
    .filter((p) => !p.archived_at && Number(p.shelf_qty) > 0)
    .sort((a, b) => Number(b.sold_qty || 0) - Number(a.sold_qty || 0))
    .slice(0, 12), [products]);

  const shiftBar = usesShifts && (
    <div className="card flex-between shift-bar" style={{ padding: '10px 16px' }}>
      {shift ? (
        <>
          <span>🟢 {t('shift.onShift', { time: new Date(shift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })} · {t('shift.expectedCash')}: <strong>{formatCurrency(shift.expected_cash_now)}</strong></span>
          <button className="btn small secondary" onClick={() => { setShiftForm({ amount: '', notes: '' }); setShiftModal('close'); }}>{t('shift.end')}</button>
        </>
      ) : (
        <>
          <span className="muted">{t('shift.noShift')}</span>
          <button className="btn small secondary" onClick={() => { setShiftForm({ amount: '', notes: '' }); setShiftModal('open'); }}>{t('shift.start')}</button>
        </>
      )}
    </div>
  );

  const shiftDialog = shiftModal && (
    <Modal title={shiftModal === 'open' ? t('shift.startTitle') : t('shift.endTitle')} onClose={() => setShiftModal(null)}>
      <form onSubmit={submitShift}>
        {shiftModal === 'close' && shift && <p className="muted">{t('shift.expectedCash')}: <strong>{formatCurrency(shift.expected_cash_now)}</strong></p>}
        <div className="form-group">
          <label htmlFor="shift-amount">{shiftModal === 'open' ? t('shift.openingFloat') : t('shift.countedCash')}</label>
          <input id="shift-amount" type="number" min="0" step="0.01" inputMode="decimal" autoFocus value={shiftForm.amount} onChange={(e) => setShiftForm({ ...shiftForm, amount: e.target.value })} required={shiftModal === 'close'} />
        </div>
        {shiftModal === 'close' && (
          <div className="form-group">
            <label htmlFor="shift-notes">{t('shift.notes')}</label>
            <input id="shift-notes" value={shiftForm.notes} onChange={(e) => setShiftForm({ ...shiftForm, notes: e.target.value })} />
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={() => setShiftModal(null)}>{t('common.cancel')}</button>
          <button className="btn">{shiftModal === 'open' ? t('shift.start') : t('shift.end')}</button>
        </div>
      </form>
    </Modal>
  );

  if (receipt) {
    return (
      <div>
        <div className="topbar"><h1>{t('checkout.receiptTitle')}</h1></div>
        <ReceiptView receipt={receipt} onToast={showToast} />
        <button className="btn mt-1" onClick={() => setReceipt(null)}>{t('checkout.newOrder')}</button>
        <Toast {...(toast || {})} />
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <div className="topbar"><h1>{t('checkout.title')}</h1></div>
        <Alert type="error">{error}</Alert>
        {shiftBar}
        <div className="card">
          <button className="btn" onClick={startOrder}>{t('checkout.startNewOrder')}</button>
          <p className="muted mt-1">{t('checkout.shortcutsHint')}</p>
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('checkout.pendingOrders')} {canPay ? t('checkout.pendingOrdersHint') : ''}</h3>
          {pending.length === 0 && <p className="muted">{t('checkout.noPendingOrders')}</p>}
          {pending.map((o) => (
            <div key={o.id} className="flex" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee' }}>
              <span>
                {o.parked_label && <strong>⏸ {o.parked_label} · </strong>}
                {t('checkout.orderStartedBy', { name: o.created_by_name || t('checkout.someone') })} · {formatCurrency(o.total)}
              </span>
              <button className="btn small" onClick={() => pickUp(o.id)}>{t('checkout.open')}</button>
            </div>
          ))}
        </div>
        {shiftDialog}
        <Toast {...(toast || {})} />
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
            <label htmlFor="checkout-search">{t('checkout.searchLabel')}</label>
            <input id="checkout-search" ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} placeholder={t('checkout.searchPlaceholder')} autoComplete="off" />
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
          {search.length === 0 && quickPicks.length > 0 && (
            <>
              <h4 className="mt-1">{t('checkout.quickPicks')}</h4>
              <div className="quick-picks">
                {quickPicks.map((p) => (
                  <button key={p.id} type="button" className="quick-pick" onClick={() => addProduct(p.id, 'manual_search')} title={p.sku}>
                    <span className="qp-name">{p.name}</span>
                    <span className="qp-price">{formatCurrency(Number(p.cost_price) * Number(p.price_multiplier))}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('checkout.orderItems')}</h3>
          {(!order.items || order.items.length === 0) && <p className="muted">{t('checkout.noItemsYet')}</p>}
          {order.items?.map((item) => (
            <div key={item.id} className="flex" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span>{item.product_name} × {item.quantity}</span>
              <span>{formatCurrency(item.line_total)} <button className="btn danger small" aria-label={t('checkout.removeItem')} onClick={() => removeItem(item.id)}>✕</button></span>
            </div>
          ))}

          {Number(order.discount_amount) > 0 && (
            <div className="flex-between mt-1 muted">
              <span>{t('receipt.discount')}{order.discount_reason ? ` (${order.discount_reason})` : ''} <button className="btn small secondary" onClick={removeDiscount}>{t('checkout.removeDiscount')}</button></span>
              <span>−{formatCurrency(order.discount_amount)}</span>
            </div>
          )}
          {Number(order.tax_amount) > 0 && (
            <div className="flex-between muted"><span>{t('receipt.tax')} {Number(order.tax_rate_pct)}%{order.tax_inclusive ? ` ${t('receipt.inclusive')}` : ''}</span><span>{formatCurrency(order.tax_amount)}</span></div>
          )}
          <div className="flex mt-1" style={{ justifyContent: 'space-between', fontWeight: 700, fontSize: 18 }}>
            <span>{t('checkout.total')}</span><span>{formatCurrency(order.total || 0)}</span>
          </div>
          {order.items?.length > 0 && (
            <button className="btn small secondary mt-1" onClick={() => setDiscountModal(true)}>🏷️ {t('checkout.addDiscount')}</button>
          )}

          {canPay ? (
            <div className="mt-1">
              {!splitMode ? (
                <>
                  <div className="form-group">
                    <label htmlFor="payment-method">{t('checkout.paymentMethod')}</label>
                    <select id="payment-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                      <option value="cash">{t('checkout.cash')}</option>
                      <option value="card">{t('checkout.card')}</option>
                      <option value="transfer">{t('checkout.transfer')}</option>
                      <option value="mobile_money">{t('checkout.mobileMoney')}</option>
                      <option value="credit">{t('checkout.credit')}</option>
                      <option value="other">{t('checkout.other')}</option>
                    </select>
                  </div>
                  {paymentMethod === 'cash' && (
                    <div className="form-group">
                      <label htmlFor="cash-received">{t('checkout.amountReceived')}</label>
                      <input id="cash-received" type="number" min="0" step="0.01" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(total)} />
                    </div>
                  )}
                </>
              ) : (
                <div className="form-group">
                  <label>{t('checkout.splitPayments')}</label>
                  {splits.map((s, idx) => (
                    <div key={idx} className="flex" style={{ marginBottom: 6 }}>
                      <select aria-label={`${t('checkout.paymentMethod')} ${idx + 1}`} value={s.method} onChange={(e) => setSplits(splits.map((x, i) => (i === idx ? { ...x, method: e.target.value } : x)))} style={{ maxWidth: 160 }}>
                        {METHODS.map((m) => <option key={m} value={m}>{t(`checkout.${m === 'mobile_money' ? 'mobileMoney' : m}`)}</option>)}
                      </select>
                      <input aria-label={`${t('checkout.amount')} ${idx + 1}`} type="number" min="0" step="0.01" inputMode="decimal" value={s.amount} onChange={(e) => setSplits(splits.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))} style={{ maxWidth: 140 }} />
                      {splits.length > 2 && <button type="button" className="btn small secondary" onClick={() => setSplits(splits.filter((_, i) => i !== idx))}>✕</button>}
                    </div>
                  ))}
                  <button type="button" className="btn small secondary" onClick={() => setSplits([...splits, { method: 'transfer', amount: '' }])}>+ {t('checkout.addTender')}</button>
                  <p className="muted">{t('checkout.remaining')}: {formatCurrency(Math.max(0, total - splitTotal))}</p>
                </div>
              )}
              {(paymentMethod === 'credit' || (splitMode && splits.some((s) => s.method === 'credit'))) && (
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
              {changeDue > 0 && <p style={{ fontSize: 18, fontWeight: 700 }}>{t('receipt.change')}: {formatCurrency(changeDue)}</p>}
              <div className="flex">
                <button ref={payRef} className="btn" onClick={pay} disabled={!order.items?.length}>{t('checkout.confirmPayment')}</button>
                <button type="button" className="btn small secondary" onClick={() => setSplitMode((m) => !m)}>{splitMode ? t('checkout.singlePayment') : t('checkout.splitPayment')}</button>
              </div>
            </div>
          ) : (
            <p className="muted mt-1">{t('checkout.readyForCashier')}</p>
          )}
          <div className="flex mt-1">
            {order.items?.length > 0 && <button className="btn secondary small" onClick={parkOrder}>⏸ {t('checkout.park')}</button>}
            <button className="btn secondary small" onClick={cancelOrder}>{t('checkout.cancelOrder')}</button>
          </div>
        </div>
      </div>

      {discountModal && (
        <Modal title={t('checkout.addDiscount')} onClose={() => setDiscountModal(false)}>
          <form onSubmit={submitDiscount}>
            <div className="flex">
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="disc-type">{t('checkout.discountType')}</label>
                <select id="disc-type" value={discount.type} onChange={(e) => setDiscount({ ...discount, type: e.target.value })}>
                  <option value="percent">%</option>
                  <option value="amount">{t('checkout.fixedAmount')}</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="disc-value">{t('checkout.discountValue')}</label>
                <input id="disc-value" type="number" min="0" step="0.01" inputMode="decimal" autoFocus value={discount.value} onChange={(e) => setDiscount({ ...discount, value: e.target.value })} required />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="disc-reason">{t('checkout.discountReason')}</label>
              <input id="disc-reason" value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} />
            </div>
            {discount.needsApproval && (
              <>
                <Alert type="warning">{t('checkout.approvalNeeded')}</Alert>
                <div className="form-group">
                  <label htmlFor="disc-appr-email">{t('checkout.managerEmail')}</label>
                  <input id="disc-appr-email" type="email" value={discount.approverEmail} onChange={(e) => setDiscount({ ...discount, approverEmail: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label htmlFor="disc-appr-pw">{t('checkout.managerPassword')}</label>
                  <input id="disc-appr-pw" type="password" value={discount.approverPassword} onChange={(e) => setDiscount({ ...discount, approverPassword: e.target.value })} required />
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => setDiscountModal(false)}>{t('common.cancel')}</button>
              <button className="btn">{t('checkout.applyDiscount')}</button>
            </div>
          </form>
        </Modal>
      )}
      {shiftDialog}
      <Toast {...(toast || {})} />
    </div>
  );
}

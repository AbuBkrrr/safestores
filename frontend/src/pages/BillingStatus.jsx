import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useSocket } from '../context/SocketContext.jsx';
import { Alert, Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useCurrency } from '../context/CurrencyContext.jsx';

export default function BillingStatus() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const { socket } = useSocket();
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [warning, setWarning] = useState(null);
  const [claimingId, setClaimingId] = useState(null);
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [payingId, setPayingId] = useState(null);
  const [proof, setProof] = useState(null); // receipt photo or PDF for the claim
  const [showAccount, setShowAccount] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, showToast] = useToast();
  const verifiedRef = useRef(false); // guards against double-verifying on a re-render

  const METHOD_LABELS = {
    ussd: t('billingPage.methodUssd'), bank_transfer: t('billingPage.methodBankTransfer'),
    cash: t('billingPage.methodCash'), card: t('billingPage.methodCard'),
  };

  const load = () => api.get(`/stores/${user.storeId}/billing/status`).then((r) => setStatus(r.data));
  useEffect(() => {
    load();
    api.get('/settings/payment-instructions').then((r) => setSettings(r.data)).catch(() => {});
  }, [user.storeId]);

  useEffect(() => {
    if (!socket) return undefined;
    const onWarn = (payload) => setWarning(payload);
    const onLock = () => load();
    socket.on('billing:warning', onWarn);
    socket.on('billing:locked', onLock);
    return () => { socket.off('billing:warning', onWarn); socket.off('billing:locked', onLock); };
  }, [socket]);

  // Paystack redirects the browser back to our callbackUrl with
  // ?reference=... appended. The chargeId is embedded in that reference
  // (see backend's initializeGatewayPayment: `ss_<chargeId>_<random>`),
  // so it can be recovered here without needing to persist anything
  // ourselves across the redirect to Paystack's own hosted page and back.
  useEffect(() => {
    if (verifiedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('reference') || params.get('trxref');
    if (!ref || !ref.startsWith('ss_')) return;
    verifiedRef.current = true;
    const chargeId = ref.split('_')[1];

    showToast(t('billingPage.verifyingPayment'), 'info');
    api.post(`/stores/${user.storeId}/billing/charges/${chargeId}/pay/verify`, { reference: ref })
      .then(() => {
        showToast(t('billingPage.paymentVerified'), 'success');
        load();
      })
      .catch(() => {
        showToast(t('billingPage.paymentNotVerified'), 'error');
      })
      .finally(() => {
        // Strip the query string so refreshing the page doesn't re-verify.
        window.history.replaceState({}, '', window.location.pathname);
      });
  }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitClaim = async (chargeId) => {
    try {
      if (proof) {
        const fd = new FormData();
        fd.append('chargeId', chargeId); fd.append('method', method); fd.append('reference', reference); fd.append('proof', proof);
        await api.post(`/stores/${user.storeId}/billing/claim-payment`, fd);
      } else {
        await api.post(`/stores/${user.storeId}/billing/claim-payment`, { chargeId, method, reference });
      }
      setProof(null);
      showToast(t('billingPage.claimSubmittedToast'), 'success');
      setClaimingId(null);
      setReference('');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || t('billingPage.claimSubmitFailed'), 'error');
    }
  };

  // Only offered when a Super Admin has both selected Paystack AND
  // switched it on — see updatePaymentSettings' comment on why
  // gateway_enabled is a separate flag from gateway_provider. The server
  // has its own equivalent check (plus a PAYSTACK_SECRET_KEY check the
  // frontend has no way to see), so this is a UX nicety, not the real
  // access control.
  const gatewayAvailable = import.meta.env.VITE_EDITION !== 'desktop' && settings?.gateway_provider === 'paystack' && settings?.gateway_enabled;

  const payOnline = async (chargeId) => {
    setPayingId(chargeId);
    try {
      const { data } = await api.post(`/stores/${user.storeId}/billing/charges/${chargeId}/pay/initialize`, {
        callbackUrl: window.location.href.split('?')[0],
      });
      showToast(t('billingPage.redirecting'), 'info');
      window.location.href = data.authorizationUrl;
    } catch (err) {
      showToast(err.response?.data?.error || t('billingPage.initializeFailed'), 'error');
      setPayingId(null);
    }
  };

  if (!status) return null;

  const unpaid = status.charges.filter((c) => (c.status === 'pending' || c.status === 'overdue') && !c.claimed_at);
  const claiming = status.charges.find((c) => c.id === claimingId);

  return (
    <div>
      <div className="topbar"><h1>{t('billingPage.title')}</h1></div>
      {warning && <Alert type="error">⚠️ {warning.message}</Alert>}
      {status.locked && <Alert type="error">{t('billingPage.storeLocked')}</Alert>}

      <div className="card">
        <p><strong>{t('billingPage.billingModel')}</strong> {status.billing_model === 'daily_percentage' ? t('billingPage.dailyPercentOf', { rate: status.daily_rate_percent }) : t('billingPage.customArrangement')}</p>
        {status.billing_model === 'custom' && status.custom_billing_notes && <p className="muted">{status.custom_billing_notes}</p>}
        {status.billing_model === 'daily_percentage' && <p className="muted">{t('billingPage.gracePeriod', { minutes: status.grace_period_minutes })}</p>}
      </div>

      {settings && (
        <div className="card">
          <button type="button" onClick={() => setShowAccount((v) => !v)} aria-expanded={showAccount} aria-controls="pay-account"
            className="flex" style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', textAlign: 'left' }}>
            <span>
              <strong style={{ fontSize: 17 }}>{t('billingPage.howToPay')}</strong>
              <span className="muted" style={{ marginLeft: 8 }}>{settings.bank_or_provider} · {t('billingPage.accountEnding', { last: String(settings.account_number || '').slice(-4) })}</span>
            </span>
            <span aria-hidden="true" style={{ fontSize: 14, transition: 'transform .15s', transform: showAccount ? 'rotate(180deg)' : 'none' }}>▼</span>
          </button>
          {showAccount && (
            <div id="pay-account" className="mt-1">
              <table><tbody>
                <tr><td className="muted">{t('billingPage.bankOrProvider')}</td><td><strong>{settings.bank_or_provider}</strong></td></tr>
                <tr><td className="muted">{t('billingPage.accountNumber')}</td><td>
                  <span className="code-chip">{settings.account_number}</span>{' '}
                  <button type="button" className="btn small secondary" onClick={() => { navigator.clipboard?.writeText(String(settings.account_number)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}>
                    {copied ? t('billingPage.copied') : t('billingPage.copy')}
                  </button>
                </td></tr>
                <tr><td className="muted">{t('billingPage.accountName')}</td><td>{settings.account_name}</td></tr>
                <tr><td className="muted">{t('billingPage.acceptedMethods')}</td><td>{(settings.methods || []).map((m) => METHOD_LABELS[m] || m).join(', ')}</td></tr>
              </tbody></table>
              {settings.instructions && <p className="muted mt-1">{settings.instructions}</p>}
            </div>
          )}
          {unpaid.length > 0 && (
            <div className="flex mt-1" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn" onClick={() => setClaimingId(unpaid[0].id)}>📎 {t('billingPage.uploadReceiptConfirm')}</button>
              <span className="muted" style={{ fontSize: 13 }}>{t('billingPage.uploadReceiptHint')}</span>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('billingPage.recentCharges')}</h3>
        <table>
          <thead><tr><th>{t('billingPage.date')}</th><th>{t('billingPage.transactions')}</th><th>{t('billingPage.rate')}</th><th>{t('billingPage.amountDue')}</th><th>{t('usersPage.status')}</th><th></th></tr></thead>
          <tbody>
            {status.charges.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.charge_date).toLocaleDateString()}</td>
                <td>{formatCurrency(c.transaction_total)}</td>
                <td>{c.rate_percent}%</td>
                <td>{formatCurrency(c.amount_due)}</td>
                <td><Badge status={c.status} /></td>
                <td>
                  {(c.status === 'pending' || c.status === 'overdue') && !c.claimed_at && (
                    claimingId === c.id ? null : (
                      <div className="flex" style={{ alignItems: 'center', gap: 8 }}>
                        <button className="btn small" onClick={() => setClaimingId(c.id)}>{t('billingPage.ivePaid')}</button>
                        {gatewayAvailable && (
                          <>
                            <span className="muted" style={{ fontSize: 12 }}>{t('billingPage.orPayOnline')}</span>
                            <button className="btn small secondary" onClick={() => payOnline(c.id)} disabled={payingId === c.id}>
                              {payingId === c.id ? t('billingPage.redirecting') : t('billingPage.payOnlineNow')}
                            </button>
                          </>
                        )}
                      </div>
                    )
                  )}
                  {(c.status === 'pending' || c.status === 'overdue') && c.claimed_at && (
                    <span className="muted">{t('billingPage.claimSubmittedFor', { method: METHOD_LABELS[c.claim_method] || c.claim_method })}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.charges.length === 0 && <p className="muted">{t('billingPage.noChargesYet')}</p>}
      </div>

      {claimingId && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('billingPage.confirmYourPayment')}</h3>
          {claiming && <p className="muted">{t('billingPage.forCharge', { date: new Date(claiming.charge_date).toLocaleDateString(), amount: formatCurrency(claiming.amount_due) })}</p>}
          <div className="form-group">
            <label>{t('billingPage.paymentMethod')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="ussd">{t('billingPage.methodUssd')}</option>
              <option value="bank_transfer">{t('billingPage.methodBankTransfer')}</option>
              <option value="cash">{t('billingPage.methodCash')}</option>
              <option value="card">{t('billingPage.methodCard')}</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('billingPage.paymentReference')}</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. OPAY-REF-12345" />
          </div>
          <div className="form-group">
            <label htmlFor="claim-proof">{t('billingPage.receiptFile')}</label>
            <input id="claim-proof" type="file" accept="image/*,application/pdf" onChange={(e) => setProof(e.target.files?.[0] || null)} />
            <p className="muted" style={{ fontSize: 12 }}>{t('billingPage.receiptFileHint')}</p>
          </div>
          <div className="flex">
            <button className="btn" onClick={() => submitClaim(claimingId)}>{t('billingPage.submitClaim')}</button>
            <button className="btn secondary" onClick={() => { setClaimingId(null); setProof(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

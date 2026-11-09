import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { formatCurrency } from '../utils/currency.js';
import { BrandFooter } from '../components/ui.jsx';

const STEPS = ['placed', 'fulfilled'];

/** Public order-tracking page for online shoppers (link shown after checkout). */
export default function TrackOrder() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [params] = useSearchParams();
  const [payMsg, setPayMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [o, setO] = useState(null);
  const [error, setError] = useState('');

  // Back from Paystack checkout (?reference=… or ?trxref=…): confirm with the server first.
  useEffect(() => {
    const ref = params.get('reference') || params.get('trxref');
    if (!ref) return;
    api.post(`/marketplace/orders/${encodeURIComponent(token)}/verify`, { reference: ref })
      .then((r) => { setPayMsg(r.data.paid ? t('trackPage.paymentReceived') : t('trackPage.paymentNotConfirmed')); return api.get(`/public/marketplace-orders/${encodeURIComponent(token)}`); })
      .then((r) => setO(r.data))
      .catch(() => setPayMsg(t('trackPage.paymentNotConfirmed')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const payNow = async () => {
    setBusy(true);
    try {
      let res;
      try { res = await api.post(`/marketplace/orders/${encodeURIComponent(token)}/pay`, {}); } catch (err) {
        if (err.response?.data?.code !== 'EMAIL_REQUIRED') throw err;
        const email = prompt(t('trackPage.emailPrompt'));
        if (!email) return;
        res = await api.post(`/marketplace/orders/${encodeURIComponent(token)}/pay`, { email });
      }
      window.location.assign(res.data.authorizationUrl);
    } catch (err) {
      setPayMsg(err.response?.data?.error || t('common.errorGeneric'));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const load = () => api.get(`/public/marketplace-orders/${encodeURIComponent(token)}`).then((r) => setO(r.data)).catch(() => setError(t('trackPage.notFound')));
    load();
    const id = setInterval(load, 60000); // refresh while the page is open
    return () => clearInterval(id);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = o ? { code: o.currency_code, symbol: o.currency_symbol } : undefined;
  const stepIndex = o ? (o.status === 'cancelled' ? -1 : STEPS.indexOf(o.status)) : 0;

  return (
    <div className="auth-screen">
      <div className="card" style={{ width: '100%', maxWidth: 520 }}>
        {error && <p>{error}</p>}
        {o && (
          <>
            <h1 style={{ fontSize: 22 }}>{o.store_name}</h1>
            <p className="muted">{t('trackPage.reference')}: <strong>{o.reference}</strong> · {new Date(o.created_at).toLocaleString()}</p>
            {o.status === 'cancelled' ? <div className="alert error">{t('trackPage.cancelled')}</div> : (
              <ol className="track-steps">
                {STEPS.map((s, i) => <li key={s} className={i <= stepIndex ? 'done' : ''}>{t(`trackPage.steps.${s}`)}</li>)}
              </ol>
            )}
            {payMsg && <div className={`alert ${o.payment_status === 'paid' ? 'success' : 'info'}`}>{payMsg}</div>}
            <p>
              {o.payment_status === 'paid'
                ? <span className="badge active">✅ {t('trackPage.paid')}</span>
                : <span className="badge pending">{o.payment_method === 'online' ? t('trackPage.awaitingPayment') : t('trackPage.payOnDelivery')}</span>}
            </p>
            {o.payment_status !== 'paid' && o.status !== 'cancelled' && o.can_pay_online && (
              <button className="btn" disabled={busy} onClick={payNow}>{t('trackPage.payNow')}</button>
            )}
            <div className="mt-1">
              {o.items.map((i, idx) => <div key={idx} className="flex-between"><span>{i.name} × {i.quantity}</span><span>{formatCurrency(i.unit_price * i.quantity, c)}</span></div>)}
              <div className="flex-between" style={{ fontWeight: 700, marginTop: 6 }}><span>{t('checkout.total')}</span><span>{formatCurrency(o.total, c)}</span></div>
            </div>
            {o.store_phone && <p className="mt-1">{t('trackPage.questions')} <a href={`tel:${o.store_phone}`}>{o.store_phone}</a></p>}
          </>
        )}
        <BrandFooter />
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { formatCurrency } from '../utils/currency.js';
import { BrandFooter } from '../components/ui.jsx';

const STEPS = ['placed', 'fulfilled'];

/** Public order-tracking page for online shoppers (link shown after checkout). */
export default function TrackOrder() {
  const { t } = useTranslation();
  const { token } = useParams();
  const [o, setO] = useState(null);
  const [error, setError] = useState('');

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

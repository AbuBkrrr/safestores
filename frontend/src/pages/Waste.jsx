import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert, Metric } from '../components/ui.jsx';
import { fmtQty } from '../utils/businessTypes.js';

// Fresh food: see what is close to spoiling, write off what went bad at the
// end of the day, and see what waste cost this week.
export default function Waste() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState({});
  const load = () => api.get(`/stores/${user.storeId}/waste`, { params: { days } }).then((r) => setData(r.data)).catch(() => {});
  useEffect(() => { load(); }, [user.storeId, days]); // eslint-disable-line react-hooks/exhaustive-deps

  const writeOff = async (p) => {
    const f = form[p.id] || {};
    setMsg({});
    try {
      await api.post(`/stores/${user.storeId}/movements`, { productId: p.id, type: f.type || 'expiry', quantity: Number(f.qty), note: f.note || t('waste.endOfDay') });
      setForm({ ...form, [p.id]: {} });
      setMsg({ type: 'success', text: t('waste.recorded', { qty: fmtQty(f.qty, p), name: p.name }) });
      load();
    } catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('waste.failed') }); }
  };
  const daysLeft = (d) => (d ? Math.round((new Date(d) - new Date(new Date().toISOString().slice(0, 10))) / 86400000) : null);

  return (
    <div>
      <div className="topbar"><div className="page-title"><h1>🥬 {t('waste.title')}</h1><div className="sub">{t('waste.sub')}</div></div></div>
      <Alert type={msg.type}>{msg.text}</Alert>
      {data && (
        <div className="grid grid-4">
          <Metric value={formatCurrency(data.totalValue)} label={t('waste.lostValue', { days })} />
          <Metric value={data.items.length} label={t('waste.productsWasted')} />
          <Metric value={data.fresh.filter((f) => daysLeft(f.next_expiry) !== null && daysLeft(f.next_expiry) <= 1).length} label={t('waste.dueToday')} />
          <div className="card" style={{ display: 'grid', placeItems: 'center' }}>
            <select aria-label={t('waste.period')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 7, 30].map((d) => <option key={d} value={d}>{t('waste.lastDays', { count: d })}</option>)}
            </select>
          </div>
        </div>
      )}
      <div className="card">
        <h3>{t('waste.freshStock')}</h3>
        {!data ? <p className="muted">…</p> : data.fresh.length === 0 ? <p className="muted">{t('waste.noFresh')}</p> : (
          <div style={{ overflowX: 'auto' }}><table>
            <thead><tr><th>{t('waste.product')}</th><th>{t('waste.onShelf')}</th><th>{t('waste.expires')}</th><th>{t('waste.writeOff')}</th></tr></thead>
            <tbody>{data.fresh.map((p) => {
              const dl = daysLeft(p.next_expiry);
              const f = form[p.id] || {};
              return (
                <tr key={p.id} style={dl !== null && dl <= 1 ? { background: 'var(--offline-bg)' } : undefined}>
                  <td>{p.name}<div className="muted" style={{ fontSize: 11 }}>{[p.storage_type !== 'ambient' && t(`products.${p.storage_type}`), p.shelf_life_days && t('waste.keeps', { n: p.shelf_life_days })].filter(Boolean).join(' · ')}</div></td>
                  <td>{fmtQty(p.shelf_qty, p)}{Number(p.backroom_qty) > 0 && <div className="muted" style={{ fontSize: 11 }}>+ {fmtQty(p.backroom_qty, p)} {t('waste.inStore')}</div>}</td>
                  <td>{p.next_expiry ? (dl < 0 ? t('waste.expired') : dl === 0 ? t('waste.today') : t('waste.inDays', { count: dl })) : '—'}</td>
                  <td>
                    <span className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                      <input type="number" step="any" min="0" aria-label={t('waste.qtyOf', { name: p.name })} placeholder={p.unit} value={f.qty || ''} onChange={(e) => setForm({ ...form, [p.id]: { ...f, qty: e.target.value } })} style={{ width: 80 }} />
                      <select aria-label={t('waste.reason')} value={f.type || 'expiry'} onChange={(e) => setForm({ ...form, [p.id]: { ...f, type: e.target.value } })}>
                        <option value="expiry">{t('waste.spoiled')}</option><option value="damage">{t('waste.damaged')}</option>
                      </select>
                      <button className="btn small" disabled={!(Number(f.qty) > 0)} onClick={() => writeOff(p)}>{t('waste.writeOffBtn')}</button>
                    </span>
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      {data && data.items.length > 0 && (
        <div className="card">
          <h3>{t('waste.whatWasLost', { count: days })}</h3>
          <table><tbody>{data.items.map((i) => <tr key={i.id}><td>{i.name}</td><td>{fmtQty(i.quantity, i)}</td><td style={{ textAlign: 'right' }}>{formatCurrency(i.value)}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

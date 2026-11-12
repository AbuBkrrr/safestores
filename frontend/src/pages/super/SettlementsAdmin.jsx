import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { useCurrency } from '../../context/CurrencyContext.jsx';
import { Alert, EmptyState, Metric, Modal } from '../../components/ui.jsx';

// Super Admin console — English-only, like the rest of /super (see Layout.jsx).
const TYPES = {
  cash_commission: 'Cash order — commission owed', online_commission: 'Online order — commission withheld',
  debt_recovered: 'Recovered from online payment', settlement_payment: 'Payment received', adjustment: 'Adjustment',
};

export default function SettlementsAdmin() {
  const { formatCurrency: f } = useCurrency();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [entry, setEntry] = useState(null);   // { store, type, amount, reference, note }
  const [view, setView] = useState(null);     // { store, statement }

  const load = () => api.get('/super/settlements').then((r) => {
    setData(r.data);
    setForm((cur) => cur || { ...r.data.settings });
  });
  useEffect(() => { load(); }, []);

  const run = async (fn, done) => {
    setError(''); setOk('');
    try { await fn(); if (done) setOk(done); load(); return true; } catch (err) { setError(err.response?.data?.error || 'Something went wrong'); return false; }
  };

  const saveSettings = (e) => {
    e.preventDefault();
    run(() => api.patch('/super/settlement-settings', {
      marketplaceCommissionPct: Number(form.marketplaceCommissionPct), cashDebtLimit: Number(form.cashDebtLimit), maxRecoveryPct: Number(form.maxRecoveryPct),
    }), 'Settings saved');
  };

  const setCommission = (store) => {
    const v = prompt(`Commission % for ${store.name} (leave empty for the platform default):`, store.commission_pct ?? '');
    if (v === null) return;
    run(() => api.patch(`/super/stores/${store.id}/commission`, { commissionPct: v.trim() === '' ? null : Number(v) }), 'Commission updated');
  };

  const saveEntry = async (e) => {
    e.preventDefault();
    const done = await run(() => api.post(`/super/settlements/${entry.store.id}/entries`, {
      type: entry.type, amount: Number(entry.amount), reference: entry.reference || undefined, note: entry.note || undefined,
    }), entry.type === 'settlement_payment' ? 'Payment recorded' : 'Adjustment recorded');
    if (done) setEntry(null);
  };

  const openStatement = async (store) => setView({ store, statement: (await api.get(`/super/settlements/${store.id}`)).data });

  if (!data || !form) return <p className="muted">Loading…</p>;
  return (
    <div>
      <div className="topbar"><div><h1>💱 Store Settlements</h1><p className="muted">Commission on storefront orders. Online payments settle to stores directly with your commission withheld; pay-on-delivery orders add commission to the store&apos;s balance, which is netted from its next online payments or paid by the store.</p></div></div>
      <Alert type="error">{error}</Alert>
      <Alert type="success">{ok}</Alert>

      <div className="grid grid-4">
        <Metric value={f(data.totalOwed)} label="Owed to the platform" />
        <Metric value={data.stores.length} label="Stores with app orders" />
      </div>

      <form className="card" onSubmit={saveSettings}>
        <h3>Settlement rules</h3>
        <div className="grid grid-4">
          <div className="form-group"><label htmlFor="sa-com">Commission on app orders (%)</label><input id="sa-com" type="number" min="0" max="50" step="0.1" value={form.marketplaceCommissionPct} onChange={(e) => setForm({ ...form, marketplaceCommissionPct: e.target.value })} /></div>
          <div className="form-group"><label htmlFor="sa-lim">Balance limit before pay-on-delivery pauses (0 = no limit)</label><input id="sa-lim" type="number" min="0" step="1" value={form.cashDebtLimit} onChange={(e) => setForm({ ...form, cashDebtLimit: e.target.value })} /></div>
          <div className="form-group"><label htmlFor="sa-rec">Max share of an online payment used to clear a balance (%)</label><input id="sa-rec" type="number" min="0" max="90" step="1" value={form.maxRecoveryPct} onChange={(e) => setForm({ ...form, maxRecoveryPct: e.target.value })} /></div>
        </div>
        <button className="btn">Save rules</button>
      </form>

      <div className="card">
        <h3>Stores</h3>
        {data.stores.length === 0 ? <EmptyState>No app orders yet.</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Store</th><th>Commission</th><th style={{ textAlign: 'right' }}>Commission earned</th><th style={{ textAlign: 'right' }}>Balance</th><th>Last activity</th><th></th></tr></thead>
            <tbody>{data.stores.map((s) => (
              <tr key={s.id}>
                <td>{s.name}{s.city ? <span className="muted"> · {s.city}</span> : null}</td>
                <td><button className="btn small secondary" onClick={() => setCommission(s)}>{s.commission_pct == null ? `${data.settings.marketplaceCommissionPct}% (default)` : `${s.commission_pct}%`}</button></td>
                <td style={{ textAlign: 'right' }}>{f(s.commissions_total)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: s.balance > 0 ? 'var(--danger)' : undefined }}>{s.balance > 0 ? `owes ${f(s.balance)}` : s.balance < 0 ? `credit ${f(-s.balance)}` : 'clear'}</td>
                <td>{s.last_activity ? new Date(s.last_activity).toLocaleDateString() : '—'}</td>
                <td className="flex">
                  <button className="btn small secondary" onClick={() => openStatement(s)}>Statement</button>
                  <button className="btn small" onClick={() => setEntry({ store: s, type: 'settlement_payment', amount: s.balance > 0 ? s.balance : '', reference: '', note: '' })}>Record payment</button>
                  <button className="btn small secondary" onClick={() => setEntry({ store: s, type: 'adjustment', amount: '', reference: '', note: '' })}>Adjust</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {entry && (
        <Modal title={`${entry.type === 'settlement_payment' ? 'Record payment from' : 'Adjust balance for'} ${entry.store.name}`} onClose={() => setEntry(null)}>
          <form onSubmit={saveEntry}>
            <div className="form-group"><label htmlFor="en-amt">{entry.type === 'adjustment' ? 'Amount (+ store owes more, − store owes less)' : 'Amount received'}</label>
              <input id="en-amt" type="number" step="0.01" value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} required /></div>
            {entry.type === 'settlement_payment' && <div className="form-group"><label htmlFor="en-ref">Bank / transfer reference</label><input id="en-ref" value={entry.reference} onChange={(e) => setEntry({ ...entry, reference: e.target.value })} /></div>}
            <div className="form-group"><label htmlFor="en-note">Note{entry.type === 'adjustment' ? ' (required)' : ''}</label><input id="en-note" value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} required={entry.type === 'adjustment'} /></div>
            <div className="modal-actions"><button type="button" className="btn secondary" onClick={() => setEntry(null)}>Cancel</button><button className="btn">Save</button></div>
          </form>
        </Modal>
      )}

      {view && (
        <Modal title={`Statement — ${view.store.name}`} onClose={() => setView(null)}>
          <p>Balance: <strong>{view.statement.balance > 0 ? `owes ${f(view.statement.balance)}` : view.statement.balance < 0 ? `credit ${f(-view.statement.balance)}` : 'clear'}</strong>{view.statement.cashBlocked ? ' · pay-on-delivery paused' : ''}</p>
          <div className="table-wrap" style={{ maxHeight: 400, overflowY: 'auto' }}><table>
            <thead><tr><th>When</th><th>Entry</th><th style={{ textAlign: 'right' }}>Change</th></tr></thead>
            <tbody>{view.statement.entries.map((e) => (
              <tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{TYPES[e.type]}{e.order_total != null ? <span className="muted"> · order {f(e.order_total)}</span> : null}{e.note ? <div className="muted">{e.note}{e.reference ? ` · ${e.reference}` : ''}</div> : null}</td>
                <td style={{ textAlign: 'right' }}>{e.amount === 0 ? `(${f(e.commission || 0)} withheld)` : `${e.amount > 0 ? '+' : '−'}${f(Math.abs(e.amount))}`}</td></tr>
            ))}</tbody>
          </table></div>
        </Modal>
      )}
    </div>
  );
}

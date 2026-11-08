import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';
import { useCurrency } from '../../context/CurrencyContext.jsx';

const METHOD_LABELS = { ussd: 'USSD', bank_transfer: 'Bank Transfer', cash: 'Cash', card: 'Card' };

export default function BillingCharges() {
  const { formatCurrency } = useCurrency();
  const [charges, setCharges] = useState([]);
  const [filter, setFilter] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get('/super/billing-charges', { params: filter ? { status: filter } : {} }).then((r) => setCharges(r.data));
  useEffect(() => { load(); }, [filter]);

  const markPaid = async (id) => {
    await api.patch(`/super/billing-charges/${id}/mark-paid`);
    showToast('Charge marked paid — store unlocked if it was locked', 'success');
    load();
  };

  const waive = async (id) => {
    if (!window.confirm('Waive this charge without payment? This will unlock the store if it was locked.')) return;
    await api.patch(`/super/billing-charges/${id}/waive`);
    showToast('Charge waived — store unlocked if it was locked', 'success');
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>💰 Billing Charges</h1></div>
      <div className="card">
        <div className="form-group" style={{ maxWidth: 240 }}>
          <label>Filter by status</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="overdue">Overdue (locked)</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Store</th><th>Date</th><th>Transactions</th><th>Rate</th><th>Amount Due</th><th>Status</th><th>Claim</th><th></th></tr></thead>
          <tbody>
            {charges.map((c) => (
              <tr key={c.id}>
                <td>{c.store_name}</td>
                <td>{new Date(c.charge_date).toLocaleDateString()}</td>
                <td>{formatCurrency(c.transaction_total)}</td>
                <td>{c.rate_percent}%</td>
                <td>{formatCurrency(c.amount_due)}</td>
                <td><Badge status={c.status} /></td>
                <td>
                  {c.claimed_at ? (
                    <span className="muted">
                      {METHOD_LABELS[c.claim_method] || c.claim_method}
                      {c.claim_reference ? ` · ${c.claim_reference}` : ''}
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {(c.status === 'pending' || c.status === 'overdue') && (
                    <div className="flex">
                      <button className="btn small" onClick={() => markPaid(c.id)}>Mark Paid</button>
                      <button className="btn secondary small" onClick={() => waive(c.id)}>Waive</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {charges.length === 0 && <p className="muted">No charges yet.</p>}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

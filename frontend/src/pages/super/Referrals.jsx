import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, EmptyState } from '../../components/ui.jsx';

export default function Referrals() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => { api.get('/super/referrals').then((r) => setData(r.data)); }, []);

  if (!data) return null;
  const { referrers, stores } = data;
  const filteredStores = selected ? stores.filter((s) => s.referral_contact === selected) : stores;

  return (
    <div>
      <div className="topbar"><h1>🎯 Referrals</h1></div>
      <p className="muted mt-1" style={{ marginBottom: 16 }}>
        Every store that named a referrer at signup (or was registered with one attached), grouped by who referred
        them. Use active-store counts, not raw signups, to judge a bonus — a pending store hasn't paid for anything yet.
      </p>

      <div className="card">
        {referrers.length === 0 && <EmptyState>No referrals recorded yet.</EmptyState>}
        {referrers.length > 0 && (
          <table>
            <thead><tr><th>Referrer</th><th>Active Stores</th><th>Pending</th><th>Suspended</th><th>Total Signups</th><th>First</th><th>Last</th><th></th></tr></thead>
            <tbody>
              {referrers.map((r) => (
                <tr key={r.referralContact} style={{ cursor: 'pointer', fontWeight: selected === r.referralContact ? 700 : 400 }}
                    onClick={() => setSelected(selected === r.referralContact ? null : r.referralContact)}>
                  <td>{r.referralContact}</td>
                  <td><span className="badge active">{r.activeStores}</span></td>
                  <td>{r.pendingStores}</td>
                  <td>{r.suspendedStores}</td>
                  <td>{r.totalSignups}</td>
                  <td className="muted">{new Date(r.firstReferralAt).toLocaleDateString()}</td>
                  <td className="muted">{new Date(r.lastReferralAt).toLocaleDateString()}</td>
                  <td>{selected === r.referralContact ? 'Hide stores ▲' : 'Show stores ▼'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Stores referred by {selected}</h3>
          <table>
            <thead><tr><th>Store</th><th>Status</th><th>Signed Up</th></tr></thead>
            <tbody>
              {filteredStores.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td><Badge status={s.subscription_status} /></td>
                  <td className="muted">{new Date(s.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

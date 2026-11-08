import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

export default function Auditors() {
  const [auditors, setAuditors] = useState([]);
  const [toast, showToast] = useToast();

  const load = () => api.get('/super/auditors').then((r) => setAuditors(r.data));
  useEffect(() => { load(); }, []);

  const activate = async (id) => { await api.patch(`/super/auditors/${id}/activate`); showToast('Auditor activated', 'success'); load(); };
  const suspend = async (id) => { await api.patch(`/super/auditors/${id}/suspend`); showToast('Auditor suspended', 'success'); load(); };

  return (
    <div>
      <div className="topbar"><h1>🕵️ Auditors</h1></div>
      <div className="card">
        <p className="muted">
          Auditors are independent stock-taking service providers. Activate an applicant so
          they can accept audit-engagement requests from any store and invite their own
          stock-takers for each engagement.
        </p>
        <table className="mt-1">
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Applied</th><th></th></tr></thead>
          <tbody>
            {auditors.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td><td>{a.email}</td>
                <td><Badge status={a.status} /></td>
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
                <td className="flex">
                  {a.status !== 'active' && <button className="btn small" onClick={() => activate(a.id)}>Activate</button>}
                  {a.status === 'active' && <button className="btn secondary small" onClick={() => suspend(a.id)}>Suspend</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {auditors.length === 0 && <p className="muted">No auditor applications yet.</p>}
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}

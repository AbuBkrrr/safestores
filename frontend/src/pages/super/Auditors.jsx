import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, Modal, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

export default function Auditors() {
  const [auditors, setAuditors] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [pick, setPick] = useState({});
  const [review, setReview] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const openReview = async (id) => { setRejectNote(''); setReview((await api.get(`/super/auditors/${id}`)).data); };
  // Documents are private: fetch with the Super Admin token, open as a blob.
  const openDoc = async (d) => {
    const w = window.open('', '_blank');
    const r = await api.get(`/super/auditors/${review.id}/documents/${d.id}`, { responseType: 'blob' });
    const url = URL.createObjectURL(r.data);
    if (w) w.location = url; else window.location = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const decide = (fn, ok) => run(fn, ok).then(() => setReview(null));
  const [toast, showToast] = useToast();

  const load = () => {
    api.get('/super/auditors').then((r) => setAuditors(r.data));
    api.get('/super/audit-engagements').then((r) => setBookings(r.data));
  };
  useEffect(() => { load(); }, []);

  const run = async (fn, ok) => {
    try { await fn(); showToast(ok, 'success'); load(); } catch (e) { showToast(e.response?.data?.error || 'Failed', 'error'); }
  };
  const activate = (id) => run(() => api.patch(`/super/auditors/${id}/activate`), 'Auditor activated');
  const suspend = (id) => run(() => api.patch(`/super/auditors/${id}/suspend`), 'Auditor suspended');
  const assign = (b) => run(() => api.patch(`/super/audit-engagements/${b.id}/assign`, { auditorId: pick[b.id] }), 'Auditor assigned');
  const cancel = (b) => window.confirm('Cancel this audit booking?') && run(() => api.patch(`/super/audit-engagements/${b.id}/cancel`), 'Booking cancelled');

  const active = auditors.filter((a) => a.status === 'active');
  const unassigned = bookings.filter((b) => b.status === 'requested' && !b.auditor_id).length;
  const stateOf = (b) => (b.status === 'requested' ? (b.auditor_id ? 'Waiting for auditor' : 'Needs an auditor') : null);

  return (
    <div>
      <div className="topbar"><h1>🕵️ Auditors</h1></div>

      <div className="card">
        <h3>📅 Audit bookings {unassigned > 0 && <span className="badge pending">{unassigned} to assign</span>}</h3>
        <p className="muted">
          Stores book an audit for a date and time. Assign an active auditor; they accept (or decline, which
          sends it back here) and then invite their stock-takers for the job.
        </p>
        {bookings.length === 0 ? <p className="muted">No audit bookings yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mt-1">
              <thead><tr><th>Store</th><th>Date &amp; time</th><th>Notes</th><th>Auditor</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {bookings.map((b) => {
                  const open = ['requested', 'accepted'].includes(b.status);
                  return (
                    <tr key={b.id}>
                      <td>{b.store_name}<div className="muted" style={{ fontSize: 11 }}>{[b.store_address, b.store_city].filter(Boolean).join(', ')}{b.store_phone ? ` · ${b.store_phone}` : ''}</div>
                        <div className="muted" style={{ fontSize: 11 }}>Booked by {b.requested_by_name || '—'} · {new Date(b.requested_at).toLocaleDateString()}</div></td>
                      <td>{b.scheduled_for ? new Date(b.scheduled_for).toLocaleString() : 'Not set'}</td>
                      <td style={{ maxWidth: 220 }}>{b.notes || '—'}</td>
                      <td>
                        {open ? (
                          <span className="flex" style={{ gap: 4 }}>
                            <select aria-label="Auditor" value={pick[b.id] ?? b.auditor_id ?? ''} onChange={(e) => setPick({ ...pick, [b.id]: e.target.value })}>
                              <option value="">Choose auditor…</option>
                              {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <button className="btn small" disabled={!pick[b.id] || pick[b.id] === b.auditor_id} onClick={() => assign(b)}>{b.auditor_id ? 'Reassign' : 'Assign'}</button>
                          </span>
                        ) : (b.auditor_name || '—')}
                      </td>
                      <td><Badge status={b.status} />{stateOf(b) && <div className="muted" style={{ fontSize: 11 }}>{stateOf(b)}</div>}</td>
                      <td>{open && <button className="btn small secondary" onClick={() => cancel(b)}>Cancel</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {active.length === 0 && bookings.length > 0 && <p className="muted mt-1">Activate an auditor below before assigning bookings.</p>}
      </div>

      <div className="card">
        <h3>Auditors</h3>
        <p className="muted">
          Auditors are independent stock-taking service providers. They apply at <code>/auditor-signup</code>;
          review each applicant's KYC details and documents, then approve them so you can assign them to store bookings.
        </p>
        <table className="mt-1">
          <thead><tr><th>Name</th><th>Email / phone</th><th>Documents</th><th>Status</th><th>Applied</th><th></th></tr></thead>
          <tbody>
            {auditors.map((a) => (
              <tr key={a.id}>
                <td>{a.name}{a.company && <div className="muted" style={{ fontSize: 11 }}>{a.company}</div>}</td>
                <td>{a.email}{a.phone && <div className="muted" style={{ fontSize: 11 }}>{a.phone}</div>}</td>
                <td>{a.doc_count ? `📎 ${a.doc_count}` : <span className="muted">None</span>}</td>
                <td><Badge status={a.status} /></td>
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
                <td className="flex">
                  <button className="btn small secondary" onClick={() => openReview(a.id)}>Review</button>
                  {a.status !== 'active' && a.status !== 'pending' && <button className="btn small" onClick={() => activate(a.id)}>Activate</button>}
                  {a.status === 'active' && <button className="btn secondary small" onClick={() => suspend(a.id)}>Suspend</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {auditors.length === 0 && <p className="muted">No auditor applications yet. Share the sign-up link: <code>{window.location.origin}/auditor-signup</code></p>}
      </div>
      {review && (
        <Modal title={`KYC review — ${review.name}`} onClose={() => setReview(null)}>
          <p><Badge status={review.status} /> Applied {new Date(review.created_at).toLocaleString()}</p>
          <table>
            <tbody>
              {[['Email', review.email], ['Phone', review.phone], ['Firm', review.company], ['Address', review.address],
                ['ID', [review.id_type, review.id_number].filter(Boolean).join(' · ')],
                ['Professional body', [review.professional_body, review.membership_number].filter(Boolean).join(' · ')],
                ['Experience', review.years_experience != null ? `${review.years_experience} years` : null]].map(([k, v]) => (
                <tr key={k}><td className="muted">{k}</td><td>{v || '—'}</td></tr>
              ))}
            </tbody>
          </table>
          <h4 className="mt-1">Documents</h4>
          {review.documents.length === 0 ? <p className="muted">No documents uploaded (applied before KYC was required).</p> : (
            <ul>{review.documents.map((d) => (
              <li key={d.id}><button type="button" className="btn small secondary" onClick={() => openDoc(d)}>
                📎 {{ id_document: 'Government ID', certificate: 'Certificate', business_reg: 'Business registration', other: 'Other' }[d.doc_type]}
              </button> <span className="muted" style={{ fontSize: 11 }}>{d.filename} · {Math.round(d.size_bytes / 1024)} KB</span></li>
            ))}</ul>
          )}
          {review.review_note && <p className="muted">Last review note: {review.review_note}</p>}
          {review.status === 'pending' && (
            <div className="form-group mt-1"><label htmlFor="rej-note">Reason if rejecting (the applicant sees this)</label>
              <input id="rej-note" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="e.g. Certificate is not readable" /></div>
          )}
          <div className="modal-actions">
            {review.status !== 'active' && <button className="btn" onClick={() => decide(() => api.patch(`/super/auditors/${review.id}/activate`), 'Auditor approved')}>✅ Approve & activate</button>}
            {review.status === 'pending' && <button className="btn secondary" onClick={() => decide(() => api.patch(`/super/auditors/${review.id}/reject`, { note: rejectNote }), 'Application rejected')}>Reject</button>}
            <button className="btn secondary" onClick={() => setReview(null)}>Close</button>
          </div>
        </Modal>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

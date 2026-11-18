import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Badge, EmptyState, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

export default function SupportTickets() {
  const [tickets, setTickets] = useState([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api.get('/super/support/tickets', { params: filter ? { status: filter } : {} }).then((r) => setTickets(r.data));
  useEffect(() => { load(); }, [filter]);

  const openTicket = async (id) => {
    const { data } = await api.get(`/super/support/tickets/${id}`);
    setSelected(data);
  };

  const setStatus = async (id, status) => {
    await api.patch(`/super/support/tickets/${id}`, { status });
    showToast(`Ticket marked ${status}`, 'success');
    load();
    if (selected?.id === id) openTicket(id);
  };

  const sendReply = async () => {
    if (!replyText.trim()) return;
    await api.post(`/super/support/tickets/${selected.id}/reply`, { message: replyText });
    setReplyText('');
    openTicket(selected.id);
    load();
    showToast('Reply sent', 'success');
  };

  return (
    <div>
      <div className="topbar"><h1>🎧 Support Tickets</h1></div>

      <div className="card">
        <div className="form-group" style={{ maxWidth: 240 }}>
          <label>Filter by status</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        {tickets.length === 0 && <EmptyState>No tickets match this filter.</EmptyState>}
        {tickets.length > 0 && (
          <table>
            <thead><tr><th>Store</th><th>Subject</th><th>Priority</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>{t.store_name}</td>
                  <td>{t.subject}</td>
                  <td>{t.priority}</td>
                  <td><Badge status={t.status} /></td>
                  <td className="muted">{new Date(t.updated_at).toLocaleString()}</td>
                  <td><button className="btn small secondary" onClick={() => openTicket(t.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card mt-2">
          <div className="flex-between">
            <div>
              <h3>{selected.subject}</h3>
              <div className="muted">{selected.store_name} · Priority: {selected.priority}</div>
            </div>
            <Badge status={selected.status} />
          </div>
          <p className="mt-1">{selected.message}</p>

          <div className="mt-1" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            {selected.replies.map((r) => (
              <div key={r.id} className="mt-1">
                <strong>{r.author_type === 'super_admin' ? `${r.author_name} (Support)` : r.author_name}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(r.created_at).toLocaleString()}</span>
                <p>{r.message}</p>
              </div>
            ))}
          </div>

          <div className="mt-1">
            <textarea rows={3} placeholder="Reply to the store..." value={replyText} onChange={(e) => setReplyText(e.target.value)} />
            <div className="flex mt-1">
              <button className="btn" onClick={sendReply}>Send Reply</button>
              <button className="btn small secondary" onClick={() => setStatus(selected.id, 'resolved')}>Mark Resolved</button>
              <button className="btn small secondary" onClick={() => setStatus(selected.id, 'closed')}>Close Ticket</button>
              {selected.status !== 'open' && (
                <button className="btn small secondary" onClick={() => setStatus(selected.id, 'open')}>Reopen</button>
              )}
            </div>
          </div>
        </div>
      )}
      <Toast {...(toast || {})} />
    </div>
  );
}

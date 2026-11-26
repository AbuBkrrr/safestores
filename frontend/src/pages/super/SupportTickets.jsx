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
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, [filter]);
  // Live chats: keep the open conversation fresh so visitor messages appear by themselves.
  useEffect(() => {
    if (!selected) return undefined;
    const id = setInterval(() => api.get(`/super/support/tickets/${selected.id}`).then((r) => setSelected((cur) => (cur?.id === r.data.id ? r.data : cur))).catch(() => {}), 4000);
    return () => clearInterval(id);
  }, [selected?.id]);
  const online = (t) => t.source === 'chat' && t.visitor_seen_at && Date.now() - new Date(t.visitor_seen_at) < 60000;

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
                  <td>{t.store_id ? t.store_name : <>{t.source === 'chat' ? '💬' : '🌐'} {t.contact_name || 'Website visitor'}{online(t) && <span title="In the chat now" style={{ color: '#12a150', marginLeft: 6 }}>● online</span>}</>}</td>
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
          {!selected.store_id && (
            <div className="card mt-1" style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--line)' }}>
              <strong>{selected.source === 'chat' ? '💬 Live chat' : '🌐 From the website'}:</strong> {selected.contact_name}
              {selected.contact_phone && <> · <a href={`tel:${selected.contact_phone}`}>{selected.contact_phone}</a>
                {' '}· <a href={`https://wa.me/${selected.contact_phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a></>}
              {selected.contact_email && <> · <a href={`mailto:${selected.contact_email}`}>{selected.contact_email}</a></>}
              <div className="muted">{selected.source === 'chat' ? (online(selected) ? '● They are in the chat now — your reply appears on their screen.' : 'Your reply appears in their chat bubble' + (selected.contact_email ? ' and is emailed to them.' : '.')) : selected.contact_email ? 'Your reply below is emailed to them.' : 'No email given — reply by phone or WhatsApp.'}</div>
            </div>
          )}
          <p className="mt-1">{selected.message}</p>

          <div className="mt-1" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            {selected.replies.map((r) => (
              <div key={r.id} className="mt-1">
                <strong>{r.author_type === 'super_admin' ? `${r.author_name} (Support)` : r.author_name}{r.author_type === 'visitor' ? ' (visitor)' : ''}</strong>
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(r.created_at).toLocaleString()}</span>
                <p>{r.message}</p>
              </div>
            ))}
          </div>

          <div className="mt-1">
            <textarea rows={3} placeholder={selected.store_id ? "Reply to the store..." : selected.source === 'chat' ? "Reply in the chat..." : "Reply (emailed to them)..."}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && selected.source === 'chat') { e.preventDefault(); sendReply(); } }} value={replyText} onChange={(e) => setReplyText(e.target.value)} />
            <div className="flex mt-1">
              <button className="btn" onClick={sendReply}>Send Reply</button>
              <button className="btn small secondary" onClick={() => setStatus(selected.id, 'resolved')}>Mark Resolved</button>
              <button className="btn small secondary" onClick={() => setStatus(selected.id, 'closed')}>Close Ticket</button>
              {!selected.created_by && selected.source === 'chat' && <span className="muted small">📞 Calls work with signed-in shop owners: ask them to sign in and tap “Call support” in the chat bubble.</span>}
              {selected.created_by && (
                <button className="btn small" onClick={() => window.dispatchEvent(new CustomEvent('ss:support-ring', { detail: { userId: selected.created_by, name: selected.created_by_name || selected.contact_name, storeName: selected.store_id ? selected.store_name : '' } }))}>
                  📞 Call (voice + screen)
                </button>
              )}
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

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// Floating "chat with support" bubble. Anyone (logged in or not) can chat with
// the SAFE Stores support team; replies from Super Admin → Support Tickets
// appear here within a few seconds. The chat is found again by a secret kept
// in this browser, so it survives page reloads.
const KEY = 'ss_chat_token';
const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const put = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage blocked */ } };
const HIDE = /^\/(super|r\/|track\/|shop\/|checkout)/; // never over the till

export default function LiveChat() {
  const { pathname } = useLocation();
  const { user } = useAuth() || {};
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(get);
  const [chat, setChat] = useState(null);
  const [text, setText] = useState('');
  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const seen = useRef(0);
  const end = useRef(null);

  useEffect(() => { if (user?.name && !name) setName(user.name); }, [user?.name]);

  // Fetch the conversation: every 4s while open, every 30s while closed (for the badge).
  useEffect(() => {
    if (!token) return undefined;
    let stop = false;
    const load = () => api.get(`/m/chat/${token}`).then((r) => {
      if (stop) return;
      setChat(r.data);
      const n = r.data.messages.filter((m) => m.from === 'support').length;
      if (open) { seen.current = n; setUnread(0); } else setUnread(Math.max(0, n - seen.current));
    }).catch((e) => { if (e.response?.status === 404) { put(null); setToken(null); setChat(null); } });
    if (!seen.current && !open) {
      const n = Number((() => { try { return localStorage.getItem(`${KEY}_seen`); } catch { return 0; } })()) || 0;
      seen.current = n;
    }
    load();
    const id = setInterval(load, open ? 4000 : 30000);
    return () => { stop = true; clearInterval(id); };
  }, [token, open]);

  useEffect(() => {
    if (open) { try { localStorage.setItem(`${KEY}_seen`, String(seen.current)); } catch { /* */ } }
    end.current?.scrollIntoView({ block: 'end' });
  }, [open, chat?.messages?.length]);

  if (HIDE.test(pathname) || user?.role === 'super_admin') return null;

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    if (!token && !name.trim()) { setErr('Please add your name'); return; }
    setBusy(true); setErr('');
    try {
      const { data } = await api.post('/m/chat', { token, message: text.trim(), name: name.trim(), phone: phone.trim(), email: user?.email, page: pathname });
      if (!token) { put(data.token); setToken(data.token); }
      setText('');
      if (token) { const r = await api.get(`/m/chat/${token}`); setChat(r.data); }
    } catch (ex) {
      setErr(ex.response?.data?.error || 'Could not send. Check your internet and try again.');
    } finally { setBusy(false); }
  };

  const msgs = chat?.messages || [];
  return (
    <>
      {open && (
        <div className="livechat-panel" role="dialog" aria-label="Chat with support">
          <div className="livechat-head">
            <div><strong>💬 SAFE Stores support</strong><div className="livechat-sub">We usually reply within minutes</div></div>
            <button type="button" className="livechat-x" onClick={() => setOpen(false)} aria-label="Close chat">✕</button>
          </div>
          <div className="livechat-body">
            <div className="livechat-msg support">Hello 👋 How can we help you today?</div>
            {msgs.map((m) => (
              <div key={m.id} className={`livechat-msg ${m.from}`}>
                {m.from === 'support' && m.name && <div className="livechat-who">{m.name}</div>}
                {m.text}
                <div className="livechat-time">{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            ))}
            {token && msgs.length > 0 && !msgs.some((m) => m.from === 'support') && (
              <div className="livechat-note">Thanks! Someone from our team will answer here shortly.</div>
            )}
            <div ref={end} />
          </div>
          <form className="livechat-form" onSubmit={send}>
            {!token && (
              <div className="livechat-who-fields">
                <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                <input placeholder="Phone / WhatsApp (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />
              </div>
            )}
            {err && <div className="livechat-err">{err}</div>}
            <div className="livechat-row">
              <input placeholder="Type your message…" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Message" />
              <button className="btn" disabled={busy || !text.trim()}>{busy ? '…' : 'Send'}</button>
            </div>
          </form>
        </div>
      )}
      <button type="button" className="livechat-bubble" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close support chat' : 'Chat with support'}>
        {open ? '✕' : '💬'}
        {!open && unread > 0 && <span className="livechat-badge">{unread}</span>}
      </button>
    </>
  );
}

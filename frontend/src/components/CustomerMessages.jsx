import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents } from '../context/SocketContext.jsx';
import { mediaUrl } from '../utils/media.js';

/** Questions and item requests from shoppers, with a reply box. */
export default function CustomerMessages() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [replies, setReplies] = useState({});
  const load = () => api.get(`/stores/${user.storeId}/inquiries`).then((r) => setList(r.data)).catch(() => {});
  useEffect(() => { load(); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeEvents(['inquiry:new'], () => load());
  const reply = async (i, close) => {
    await api.post(`/stores/${user.storeId}/inquiries/${i.id}/reply`, { message: replies[i.id] || '', close });
    setReplies({ ...replies, [i.id]: '' }); load();
  };
  const open = list.filter((i) => i.status === 'open').length;
  return (
    <div className="card mt-1">
      <h3>💬 {t('inbox.title')} {open > 0 && <span className="badge pending">{open}</span>}</h3>
      {list.length === 0 && <p className="muted small">{t('inbox.empty')}</p>}
      {list.map((i) => {
        const wa = String(i.phone || '').replace(/[^0-9]/g, '');
        return (
          <div key={i.id} style={{ borderTop: '1px solid var(--border, #e5e7eb)', padding: '10px 0' }}>
            <div className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
              <strong>{i.order_ref ? `📦 ${t('inbox.aboutOrder', { ref: i.order_ref })}` : i.kind === 'request' ? `🙋 ${t('inbox.request')}` : `💬 ${t('inbox.question')}`}{i.product_name ? ` · ${i.product_name}` : ''}</strong>
              <span className={`badge ${i.status === 'open' ? 'pending' : 'active'}`}>{t(`inbox.s_${i.status}`)}</span>
            </div>
            <div className="muted small">{i.name} · {i.phone || i.email} · {new Date(i.updated_at).toLocaleString()}</div>
            {(i.messages || []).map((m, k) => (
              <div key={k} className="small" style={{ margin: '4px 0', paddingLeft: m.from_store ? 16 : 0 }}><strong>{m.from_store ? `${m.author_name || t('inbox.you')}: ` : `${i.name}: `}</strong>{m.body}
                {m.image_url && <a href={mediaUrl(m.image_url)} target="_blank" rel="noreferrer"><img src={mediaUrl(m.image_url)} alt={t('orderChat.photo')} style={{ display: 'block', maxWidth: 220, maxHeight: 220, borderRadius: 8, marginTop: 4 }} /></a>}</div>
            ))}
            {i.status !== 'closed' && (
              <div className="flex" style={{ gap: 6, marginTop: 6, flexWrap: 'nowrap' }}>
                <input value={replies[i.id] || ''} onChange={(e) => setReplies({ ...replies, [i.id]: e.target.value })} placeholder={t('inbox.replyPh')} aria-label={t('inbox.replyPh')} style={{ flex: 1 }} />
                <button type="button" className="btn small" disabled={!replies[i.id]} onClick={() => reply(i, false)}>{t('inbox.send')}</button>
                {wa && <a className="btn secondary small" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">💬</a>}
                <button type="button" className="btn secondary small" onClick={() => reply(i, true)} aria-label={t('inbox.close')}>✓</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

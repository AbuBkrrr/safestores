import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { mediaUrl } from '../utils/media.js';

/**
 * Chat with the shop about this order, right in the tracking box: type a
 * message and/or attach a photo (e.g. the transfer receipt). The shop
 * answers from its Customer messages inbox; replies show up here by themselves.
 */
export default function OrderChat({ token, storeName }) {
  const { t } = useTranslation();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef(null);
  const fileRef = useRef(null);
  const url = `/public/marketplace-orders/${encodeURIComponent(token)}/chat`;

  useEffect(() => {
    let stop = false;
    const load = () => api.get(url).then((r) => { if (!stop) setMsgs(Array.isArray(r.data) ? r.data : []); }).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => { stop = true; clearInterval(id); };
  }, [url]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs.length]);

  const choose = (file) => {
    setPhoto(file || null);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return file ? URL.createObjectURL(file) : ''; });
  };

  const send = async (e) => {
    e.preventDefault();
    if ((!text.trim() && !photo) || busy) return;
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      if (text.trim()) fd.append('message', text.trim());
      if (photo) fd.append('photo', photo);
      await api.post(url, fd);
      setText(''); choose(null); if (fileRef.current) fileRef.current.value = '';
      const r = await api.get(url); setMsgs(r.data);
    } catch (ex) {
      setErr(ex.response?.data?.error || t('orderChat.failed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="order-chat mt-1">
      <strong>💬 {t('orderChat.title', { store: storeName || '' })}</strong>
      <div className="order-chat-body">
        {msgs.length === 0 && <div className="muted small">{t('orderChat.empty')}</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`livechat-msg ${m.from_store ? 'support' : 'me'}`}>
            {m.from_store && <div className="livechat-who">{m.author_name || storeName}</div>}
            {m.image_url && <a href={mediaUrl(m.image_url)} target="_blank" rel="noreferrer"><img src={mediaUrl(m.image_url)} alt={t('orderChat.photo')} style={{ display: 'block', maxWidth: 200, maxHeight: 200, borderRadius: 8, marginBottom: m.body ? 4 : 0 }} /></a>}
            {m.body}
            <div className="livechat-time">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {preview && (
        <div className="flex" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
          <img src={preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }} />
          <button type="button" className="btn small secondary" onClick={() => { choose(null); if (fileRef.current) fileRef.current.value = ''; }}>✕</button>
        </div>
      )}
      {err && <div className="livechat-err">{err}</div>}
      <form className="livechat-row" style={{ marginTop: 6 }} onSubmit={send}>
        <label className="btn secondary small" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} title={t('orderChat.attach')}>
          📎<input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => choose(e.target.files?.[0])} aria-label={t('orderChat.attach')} />
        </label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('orderChat.placeholder')} maxLength={2000} aria-label={t('orderChat.placeholder')} />
        <button className="btn small" disabled={busy || (!text.trim() && !photo)}>{busy ? '…' : t('orderChat.send')}</button>
      </form>
    </div>
  );
}

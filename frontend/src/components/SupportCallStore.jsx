import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSocket } from '../context/SocketContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { createCall, ringer, applyControl } from '../utils/supportCall.js';

/**
 * The store side of a support call: ask SAFE Stores support for a call (or
 * answer when support rings), talk, share this tab, and — only if the store
 * user switches it on — let support click and type inside SAFE Stores to set
 * the shop up. Esc or "Take back control" stops it at once.
 */
export default function SupportCallStore() {
  const { t } = useTranslation();
  const { user } = useAuth() || {};
  const { socket } = useSocket();
  const [state, setState] = useState('idle'); // idle | requesting | ringing | connecting | live
  const [peer, setPeer] = useState(null); // { id, name }
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [control, setControl] = useState(false);
  const [pointer, setPointer] = useState(null);
  const [note, setNote] = useState('');
  const call = useRef(null);
  const audio = useRef(null);
  const stopRing = useRef(null);
  const controlRef = useRef(false);
  controlRef.current = control && sharing;

  const reset = (msg = '') => {
    stopRing.current?.(); stopRing.current = null;
    call.current?.close(); call.current = null;
    setState('idle'); setPeer(null); setSharing(false); setControl(false); setPointer(null); setMuted(false); setNote(msg);
    if (msg) setTimeout(() => setNote(''), 6000);
  };

  // Start the connection once support is on the line (support makes the first offer).
  const connect = async (p) => {
    setState('connecting'); setPeer(p);
    call.current = await createCall({
      socket, peerId: p.id, polite: true,
      onRemoteStream: (stream) => { if (audio.current) { audio.current.srcObject = stream; audio.current.play?.().catch(() => {}); } },
      onData: (m) => {
        if (m.t === 'move' || m.t === 'click') setPointer({ x: m.x * window.innerWidth, y: m.y * window.innerHeight, click: m.t === 'click' });
        if (!controlRef.current || !['click', 'key', 'scroll', 'text'].includes(m.t)) return;
        applyControl(m);
      },
      onState: async (s) => {
        if (s === 'connected') {
          setState('live');
          try { await call.current.addMic(); } catch { setNote(t('supportCall.noMic')); }
        }
        if (s === 'failed') reset(t('supportCall.failed'));
      },
    });
    socket.emit('call:answer', { to: p.id });
  };

  useEffect(() => {
    if (!socket) return undefined;
    const onAccepted = (p) => { if (state === 'requesting') { stopRing.current?.(); connect({ id: p.from, name: p.name }); } };
    const onRinging = (p) => {
      if (state !== 'idle') return;
      setPeer({ id: p.from, name: p.name }); setState('ringing');
      stopRing.current = ringer();
    };
    const onEnded = (p) => { if (peer && p.from === peer.id) reset(t('supportCall.ended')); };
    socket.on('call:accepted', onAccepted); socket.on('call:ringing', onRinging); socket.on('call:ended', onEnded);
    return () => { socket.off('call:accepted', onAccepted); socket.off('call:ringing', onRinging); socket.off('call:ended', onEnded); };
  }, [socket, state, peer]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Call support" from the chat bubble or the Support page.
  useEffect(() => {
    const start = () => {
      if (!socket || state !== 'idle') { if (!socket) setNote(t('supportCall.offline')); return; }
      socket.emit('call:request', { name: user?.name, storeName: user?.storeName });
      setState('requesting');
      setTimeout(() => setState((s) => { if (s === 'requesting') { socket.emit('call:cancel'); setNote(t('supportCall.noAnswer')); return 'idle'; } return s; }), 90000);
    };
    window.addEventListener('ss:call-support', start);
    return () => window.removeEventListener('ss:call-support', start);
  }, [socket, state, user?.name, user?.storeName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc always takes control back.
  useEffect(() => {
    if (!control) return undefined;
    const k = (e) => { if (e.key === 'Escape') setControl(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [control]);
  useEffect(() => { call.current?.send({ t: 'perm', allowed: control && sharing }); }, [control, sharing]);
  useEffect(() => () => call.current?.close(), []);

  if (!user?.storeId) return null;
  const end = () => { if (peer) socket?.emit('call:end', { to: peer.id }); if (state === 'requesting') socket?.emit('call:cancel'); reset(); };
  const share = async () => {
    try {
      const thisTab = await call.current.shareScreen();
      setSharing(true);
      call.current.send({ t: 'screen', on: true, thisTab });
      if (!thisTab) setNote(t('supportCall.notThisTab'));
      const track = call.current.pc.getSenders().find((s) => s.track?.kind === 'video')?.track;
      if (track) track.addEventListener('ended', () => { setSharing(false); setControl(false); });
    } catch { setNote(t('supportCall.shareFailed')); }
  };

  if (state === 'idle' && !note) return null;
  return (
    <div data-support-call>
      <audio ref={audio} autoPlay />
      {control && sharing && (
        <div className="call-control-banner">🖱️ {t('supportCall.controlling', { name: peer?.name || '' })}
          <button type="button" className="btn small danger" onClick={() => setControl(false)}>{t('supportCall.takeBack')}</button></div>
      )}
      {pointer && sharing && <div className={`call-pointer${pointer.click ? ' click' : ''}`} style={{ left: pointer.x, top: pointer.y }} aria-hidden="true" />}
      <div className="call-panel" role="dialog" aria-label={t('supportCall.title')}>
        {note && state === 'idle' && <div className="call-note">{note} <button type="button" className="link-btn" onClick={() => setNote('')}>✕</button></div>}
        {state === 'requesting' && (<>
          <strong>📞 {t('supportCall.calling')}</strong>
          <div className="muted small">{t('supportCall.callingHelp')}</div>
          <div className="call-actions"><button type="button" className="btn small danger" onClick={end}>{t('supportCall.cancel')}</button></div>
        </>)}
        {state === 'ringing' && (<>
          <strong>📞 {t('supportCall.incoming', { name: peer?.name || '' })}</strong>
          <div className="call-actions">
            <button type="button" className="btn small" onClick={() => { stopRing.current?.(); connect(peer); }}>✅ {t('supportCall.accept')}</button>
            <button type="button" className="btn small danger" onClick={end}>{t('supportCall.decline')}</button>
          </div>
        </>)}
        {(state === 'connecting' || state === 'live') && (<>
          <strong>{state === 'live' ? `🟢 ${t('supportCall.onCall', { name: peer?.name || '' })}` : `⏳ ${t('supportCall.connecting')}`}</strong>
          {note && <div className="muted small">{note}</div>}
          <div className="call-actions">
            <button type="button" className="btn small secondary" onClick={() => { setMuted(!muted); call.current?.setMuted(!muted); }}>{muted ? `🔇 ${t('supportCall.unmute')}` : `🎙️ ${t('supportCall.mute')}`}</button>
            {!sharing
              ? <button type="button" className="btn small" disabled={state !== 'live'} onClick={share}>🖥️ {t('supportCall.share')}</button>
              : <button type="button" className="btn small secondary" onClick={() => { call.current?.stopScreen(); setSharing(false); setControl(false); }}>⏹️ {t('supportCall.stopShare')}</button>}
            <button type="button" className="btn small danger" onClick={end}>📴 {t('supportCall.end')}</button>
          </div>
          {sharing && (
            <label className="flex small" style={{ gap: 6, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" checked={control} onChange={(e) => setControl(e.target.checked)} /> {t('supportCall.allowControl')}
            </label>
          )}
          {!navigator.mediaDevices?.getDisplayMedia && <div className="muted small">{t('supportCall.phoneNoShare')}</div>}
        </>)}
      </div>
    </div>
  );
}

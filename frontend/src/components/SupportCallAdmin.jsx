import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../context/SocketContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { createCall, ringer } from '../utils/supportCall.js';

/**
 * Super Admin side of support calls: store owners' call requests ring here;
 * support can also ring a store user from a ticket. On the call: talk, see the
 * store's shared SAFE Stores tab, and — when the store user allows it — click,
 * scroll and type in it to set the shop up for them.
 */
export default function SupportCallAdmin() {
  const { user } = useAuth() || {};
  const { socket } = useSocket();
  const [incoming, setIncoming] = useState([]); // [{ from, name, storeName }]
  const [peer, setPeer] = useState(null); // { id, name, storeName }
  const [state, setState] = useState('idle'); // idle | dialing | connecting | live
  const [screenOn, setScreenOn] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState('');
  const call = useRef(null);
  const video = useRef(null);
  const audio = useRef(null);
  const pad = useRef(null);
  const stopRing = useRef(null);
  const lastMove = useRef(0);

  const reset = (msg = '') => {
    call.current?.close(); call.current = null;
    setPeer(null); setState('idle'); setScreenOn(false); setAllowed(false); setControlling(false); setMuted(false); setNote(msg);
  };

  useEffect(() => {
    if (!socket || user?.role !== 'super_admin') return undefined;
    const onIncoming = (c) => setIncoming((l) => [c, ...l.filter((x) => x.from !== c.from)].slice(0, 5));
    const drop = (p) => setIncoming((l) => l.filter((x) => x.from !== p.from));
    const onAnswered = async (p) => {
      if (state !== 'dialing' || !peer || p.from !== peer.id) return;
      setState('connecting');
      call.current = await createCall({
        socket, peerId: peer.id, polite: false,
        onRemoteStream: (stream) => {
          if (audio.current) { audio.current.srcObject = stream; audio.current.play?.().catch(() => {}); }
          const hasVideo = stream.getVideoTracks().some((tr) => tr.readyState === 'live');
          setScreenOn(hasVideo);
          if (video.current) { video.current.srcObject = hasVideo ? stream : null; }
        },
        onData: (m) => {
          if (m.t === 'perm') { setAllowed(!!m.allowed); if (!m.allowed) setControlling(false); }
          if (m.t === 'screen') { setScreenOn(!!m.on); if (m.on && m.thisTab === false) setNote('They shared something other than the SAFE Stores tab: you can watch, but clicks only work on the SAFE Stores tab.'); }
        },
        onState: async (s) => {
          if (s === 'connected') { setState('live'); try { await call.current.addMic(); } catch { setNote('No microphone: you can watch and control, but not talk.'); } }
          if (s === 'failed') reset('The connection failed (a strict mobile network may need a TURN server).');
        },
      });
    };
    const onEnded = (p) => { if (peer && p.from === peer.id) reset('The call ended.'); };
    socket.on('call:incoming', onIncoming); socket.on('call:cancelled', drop); socket.on('call:taken', drop);
    socket.on('call:answered', onAnswered); socket.on('call:ended', onEnded);
    return () => {
      socket.off('call:incoming', onIncoming); socket.off('call:cancelled', drop); socket.off('call:taken', drop);
      socket.off('call:answered', onAnswered); socket.off('call:ended', onEnded);
    };
  }, [socket, user?.role, state, peer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ring while someone is waiting and support isn't already on a call.
  useEffect(() => {
    if (incoming.length && state === 'idle') { if (!stopRing.current) stopRing.current = ringer(); }
    else { stopRing.current?.(); stopRing.current = null; }
  }, [incoming.length, state]);
  useEffect(() => () => { stopRing.current?.(); call.current?.close(); }, []);

  // From a support ticket: ring that store user.
  useEffect(() => {
    const ring = (e) => {
      if (!socket || state !== 'idle') return;
      const { userId, name, storeName } = e.detail || {};
      setPeer({ id: userId, name, storeName }); setState('dialing'); setNote('');
      socket.emit('call:ring', { to: userId, name: user?.name ? `${user.name} (SAFE Stores support)` : 'SAFE Stores support' });
    };
    window.addEventListener('ss:support-ring', ring);
    return () => window.removeEventListener('ss:support-ring', ring);
  }, [socket, state, user?.name]);

  if (user?.role !== 'super_admin') return null;

  const accept = (c) => {
    setIncoming((l) => l.filter((x) => x.from !== c.from));
    setPeer({ id: c.from, name: c.name, storeName: c.storeName }); setState('dialing'); setNote('');
    socket.emit('call:accept', { to: c.from, name: user?.name ? `${user.name} (SAFE Stores support)` : 'SAFE Stores support' });
  };
  const end = () => { if (peer) socket.emit('call:end', { to: peer.id }); reset(); };

  // Where on the shared picture (0..1) the pointer is, allowing for letterboxing.
  const at = (e) => {
    const v = video.current; if (!v || !v.videoWidth) return null;
    const r = v.getBoundingClientRect();
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale; const h = v.videoHeight * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w; const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };
  const canControl = controlling && allowed && screenOn;
  const send = (m) => call.current?.send(m);

  return (
    <div data-support-call>
      <audio ref={audio} autoPlay />
      {state === 'idle' && incoming.length > 0 && (
        <div className="call-panel admin">
          {incoming.map((c) => (
            <div key={c.from} style={{ marginBottom: 8 }}>
              <strong>📞 {c.name || 'A store user'}{c.storeName ? ` · ${c.storeName}` : ''}</strong>
              <div className="muted small">wants help on a call ({new Date(c.at).toLocaleTimeString()})</div>
              <div className="call-actions">
                <button type="button" className="btn small" onClick={() => accept(c)}>✅ Answer</button>
                <button type="button" className="btn small secondary" onClick={() => setIncoming((l) => l.filter((x) => x.from !== c.from))}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {state === 'idle' && note && <div className="call-panel admin"><span>{note}</span> <button type="button" className="link-btn" onClick={() => setNote('')}>✕</button></div>}
      {state !== 'idle' && (
        <div className="call-stage">
          <div className="call-stage-bar">
            <strong>{state === 'live' ? '🟢' : '⏳'} {peer?.name}{peer?.storeName ? ` · ${peer.storeName}` : ''}</strong>
            <span className="muted small">{state === 'dialing' ? 'Ringing…' : state === 'connecting' ? 'Connecting…' : screenOn ? (allowed ? 'Sharing their screen · control allowed' : 'Sharing their screen · watch only (they have not allowed control)') : 'Voice call · ask them to tap “Share my screen”'}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn small secondary" onClick={() => { setMuted(!muted); call.current?.setMuted(!muted); }}>{muted ? '🔇 Unmute' : '🎙️ Mute'}</button>
            <button type="button" className={`btn small${canControl ? '' : ' secondary'}`} disabled={!allowed || !screenOn}
              onClick={() => { setControlling(!controlling); setTimeout(() => pad.current?.focus(), 0); }}>🖱️ {canControl ? 'Stop controlling' : 'Control'}</button>
            <button type="button" className="btn small danger" onClick={end}>📴 End</button>
          </div>
          {note && <div className="muted small" style={{ padding: '4px 10px' }}>{note}</div>}
          <div ref={pad} tabIndex={0} className={`call-screen${canControl ? ' controlling' : ''}`}
            onMouseMove={(e) => { const now = Date.now(); if (now - lastMove.current < 80) return; lastMove.current = now; const p = at(e); if (p) send({ t: 'move', ...p }); }}
            onClick={(e) => { if (!canControl) return; const p = at(e); if (p) send({ t: 'click', ...p }); }}
            onWheel={(e) => { if (!canControl) return; const p = at(e); if (p) send({ t: 'scroll', ...p, dy: e.deltaY, dx: e.deltaX }); }}
            onKeyDown={(e) => { if (!canControl) return; if (e.ctrlKey || e.metaKey) return; e.preventDefault(); send({ t: 'key', key: e.key }); }}
            onPaste={(e) => { if (!canControl) return; send({ t: 'text', text: e.clipboardData.getData('text').slice(0, 2000) }); }}>
            <video ref={video} autoPlay playsInline muted />
            {!screenOn && <div className="call-screen-empty">{state === 'live' ? 'No screen shared yet.' : 'Waiting for them to answer…'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

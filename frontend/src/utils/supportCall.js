// One support call between a store user and SAFE Stores support, over WebRTC:
// voice both ways, the store user's screen (this tab) one way, and a small
// data channel support uses to click and type inside the shared SAFE Stores
// tab — only while the store user allows it. The socket only carries setup
// messages; audio and video go straight between the two browsers.
import api from '../api/client.js';

let iceCache = null;
async function iceServers() {
  if (iceCache) return iceCache;
  try { iceCache = (await api.get('/rtc/ice')).data.iceServers; } catch { iceCache = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  return iceCache;
}

/**
 * polite: the store side (gives way when both sides renegotiate at once).
 * Returns { pc, addMic, shareScreen, stopScreen, send, close, setMuted }.
 */
export async function createCall({ socket, peerId, polite, onRemoteStream, onData, onState }) {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  let makingOffer = false; let ignoreOffer = false;
  let channel = null;
  const remote = new MediaStream();
  const signal = (data) => socket.emit('call:signal', { to: peerId, data });

  pc.ontrack = (e) => { remote.addTrack(e.track); onRemoteStream?.(remote, e.track); e.track.onended = () => onRemoteStream?.(remote); };
  pc.onicecandidate = (e) => { if (e.candidate) signal({ candidate: e.candidate }); };
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);
  pc.onnegotiationneeded = async () => {
    try { makingOffer = true; await pc.setLocalDescription(); signal({ description: pc.localDescription }); } catch { /* retried on next change */ } finally { makingOffer = false; }
  };
  const wire = (ch) => { channel = ch; ch.onmessage = (e) => { try { onData?.(JSON.parse(e.data)); } catch { /* ignore */ } }; };
  if (!polite) wire(pc.createDataChannel('control')); // support opens the control channel
  pc.ondatachannel = (e) => wire(e.channel);

  const onSignal = async ({ from, data }) => {
    if (from !== peerId || !data) return;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') { await pc.setLocalDescription(); signal({ description: pc.localDescription }); }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!ignoreOffer) throw err; }
      }
    } catch { /* a bad message never ends the call */ }
  };
  socket.on('call:signal', onSignal);

  let mic = null; let screen = null; let screenSender = null;
  const api_ = {
    pc,
    async addMic() {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    },
    setMuted(m) { mic?.getAudioTracks().forEach((t) => { t.enabled = !m; }); },
    /** Share the screen; prefers this tab so support's clicks can land in it. Returns true if this tab is shared. */
    async shareScreen() {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
      const track = screen.getVideoTracks()[0];
      screenSender = pc.addTrack(track, screen);
      track.onended = () => api_.stopScreen();
      const surface = track.getSettings?.().displaySurface;
      return surface === 'browser' || surface === undefined;
    },
    stopScreen() {
      screen?.getTracks().forEach((t) => t.stop()); screen = null;
      if (screenSender) { try { pc.removeTrack(screenSender); } catch { /* closed */ } screenSender = null; }
      api_.send({ t: 'screen', on: false });
    },
    sharing: () => !!screen,
    send(msg) { if (channel?.readyState === 'open') channel.send(JSON.stringify(msg)); },
    close() {
      socket.off('call:signal', onSignal);
      mic?.getTracks().forEach((t) => t.stop()); screen?.getTracks().forEach((t) => t.stop());
      try { pc.close(); } catch { /* */ }
    },
  };
  return api_;
}

/** Ringing sound for an incoming call (repeats until stopped). */
export function ringer() {
  let ctx; let timer;
  const ring = () => {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime;
      [0, 0.25].forEach((at) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 660; o.connect(g).connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.4, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.2);
        o.start(t0 + at); o.stop(t0 + at + 0.22);
      });
    } catch { /* no audio */ }
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* */ }
  };
  ring(); timer = setInterval(ring, 1800);
  return () => { clearInterval(timer); try { ctx?.close(); } catch { /* */ } };
}

// ---- Applying support's clicks and typing inside this tab (store side) ----
const setNativeValue = (el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

/** msg.x / msg.y are 0..1 of the shared tab's visible area. Returns the point for the pointer overlay. */
export function applyControl(msg) {
  const x = Math.round((msg.x ?? 0) * window.innerWidth);
  const y = Math.round((msg.y ?? 0) * window.innerHeight);
  if (msg.t === 'click') {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest('[data-support-call]')) return { x, y }; // never press the call's own buttons
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts)); el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  } else if (msg.t === 'scroll') {
    const el = document.elementFromPoint(x, y);
    let s = el; while (s && s !== document.body && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    (s && s !== document.body ? s : window).scrollBy({ top: msg.dy || 0, left: msg.dx || 0 });
  } else if (msg.t === 'key') {
    const el = document.activeElement;
    if (!el || el.closest?.('[data-support-call]')) return { x, y };
    const editable = el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName);
    if (msg.key.length === 1 && editable && !el.isContentEditable) setNativeValue(el, (el.value || '') + msg.key);
    else if (msg.key === 'Backspace' && editable && !el.isContentEditable) setNativeValue(el, String(el.value || '').slice(0, -1));
    else if (msg.key === 'Enter') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      if (el.form && el.tagName === 'INPUT') el.form.requestSubmit?.();
    } else if (msg.key === 'Tab') {
      const f = [...document.querySelectorAll('input,select,textarea,button,a[href]')].filter((n) => !n.disabled && n.offsetParent);
      f[(f.indexOf(el) + 1) % f.length]?.focus();
    } else el.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key, bubbles: true }));
  } else if (msg.t === 'text') {
    const el = document.activeElement;
    if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.closest('[data-support-call]')) setNativeValue(el, (el.value || '') + String(msg.text || ''));
  }
  return { x, y };
}

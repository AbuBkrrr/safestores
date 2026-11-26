import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSocket } from '../context/SocketContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatCurrency } from '../utils/currency.js';

// A new online order: chime, a banner on whatever page the shop is on, and a
// phone/computer notification when the app is in the background. Works for
// every store, on any page, as long as someone from the shop is signed in.
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio on this device */ }
}

/** Three rising "ding-dong" chimes, made in the browser (no sound file needed). */
export function playOrderChime() {
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* */ }
  try {
    unlockAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + 0.05;
    for (let r = 0; r < 3; r += 1) {
      [[880, 0], [1320, 0.18]].forEach(([freq, at]) => {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        const start = t0 + r * 0.7 + at;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start); osc.stop(start + 0.55);
      });
    }
  } catch { /* sound is a help, never a blocker */ }
}

export default function OrderAlerts() {
  const { t } = useTranslation();
  const { user } = useAuth() || {};
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState([]);
  const asked = useRef(false);

  // Browsers only allow sound (and asking for notifications) after the person
  // has tapped the page once.
  useEffect(() => {
    const onFirstTap = () => {
      unlockAudio();
      if (!asked.current && 'Notification' in window && Notification.permission === 'default') {
        asked.current = true;
        Notification.requestPermission().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', onFirstTap);
    window.addEventListener('keydown', onFirstTap);
    return () => { window.removeEventListener('pointerdown', onFirstTap); window.removeEventListener('keydown', onFirstTap); };
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const onOrder = (order) => {
      const total = formatCurrency(Number(order?.total) || 0);
      const who = order?.customer_name || order?.buyer_name || '';
      setAlerts((a) => [{ id: order?.id || String(Date.now()), total, who }, ...a].slice(0, 3));
      playOrderChime();
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          const n = new Notification(t('orderAlert.title'), { body: t('orderAlert.body', { total }), tag: `order-${order?.id}`, requireInteraction: true });
          n.onclick = () => { window.focus(); navigate('/marketplace'); n.close(); };
        }
      } catch { /* notifications not available */ }
      const old = document.title;
      document.title = `🔔 ${t('orderAlert.title')}`;
      setTimeout(() => { document.title = old; }, 15000);
    };
    const onPaid = (o) => {
      const total = formatCurrency(Number(o?.total) || 0);
      setAlerts((a) => [{ id: `paid-${o?.id}-${Date.now()}`, total, who: '', paid: true, ref: o?.reference }, ...a].slice(0, 3));
      playOrderChime();
      try {
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          const n = new Notification(t('orderAlert.paidTitle'), { body: t('orderAlert.paidBody', { total, ref: o?.reference || '' }), tag: `paid-${o?.id}`, requireInteraction: true });
          n.onclick = () => { window.focus(); navigate('/marketplace'); n.close(); };
        }
      } catch { /* */ }
    };
    socket.on('marketplace:order_placed', onOrder);
    socket.on('marketplace:payment_sent', onPaid);
    return () => { socket.off('marketplace:order_placed', onOrder); socket.off('marketplace:payment_sent', onPaid); };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user?.storeId || !alerts.length) return null;
  return (
    <div className="order-alerts" role="alert" aria-live="assertive">
      {alerts.map((a) => (
        <div key={a.id} className="order-alert">
          <div>
            <strong>{a.paid ? `💸 ${t('orderAlert.paidTitle')}` : `🔔 ${t('orderAlert.title')}`}</strong>
            <div>{a.paid ? t('orderAlert.paidBody', { total: a.total, ref: a.ref || '' }) : t('orderAlert.body', { total: a.total })}{a.who ? ` — ${a.who}` : ''}</div>
          </div>
          <div className="order-alert-actions">
            <button type="button" className="btn small" onClick={() => { setAlerts((l) => l.filter((x) => x.id !== a.id)); navigate('/marketplace'); }}>{t('orderAlert.view')}</button>
            <button type="button" className="btn small secondary" onClick={() => setAlerts((l) => l.filter((x) => x.id !== a.id))} aria-label={t('common.close')}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

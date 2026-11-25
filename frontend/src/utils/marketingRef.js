// Which marketing link (QR code / shared link) brought this visitor, and a
// small random id for this browser — so Super Admin's Marketing tab can tell
// a returning device from the link reaching new people. No personal data.
import api from '../api/client.js';

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export function captureRef() {
  const q = new URLSearchParams(window.location.search);
  const ref = q.get('ref');
  const d = q.get('d'); // the website's id for this person, carried over
  if (ref && /^[A-Za-z0-9_-]{1,16}$/.test(ref)) set('ss_ref', ref);
  if (d && /^[A-Za-z0-9-]{8,64}$/.test(d)) set('ss_device', d);
  let deviceId = get('ss_device');
  if (!deviceId && window.crypto?.randomUUID) { deviceId = window.crypto.randomUUID(); set('ss_device', deviceId); }
  // A link that points straight at sign-up counts its opens here.
  if (ref && !d) {
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* old browser */ }
    api.post('/m/open', {
      ref, deviceId, tz, lang: navigator.language, screen: `${window.screen.width}x${window.screen.height}`,
      referrer: document.referrer, page: 'signup', signature: [navigator.userAgent, window.screen.width, window.screen.height, tz, navigator.language].join('|'),
    }).catch(() => {});
  }
  return { refCode: get('ss_ref'), refDevice: deviceId };
}

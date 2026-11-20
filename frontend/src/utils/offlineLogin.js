// Sign back in with no internet (phone and browser apps).
//
// After a successful online sign-in, the session (token + profile) is kept
// on this device locked with a key made from that person's own password
// (PBKDF2 → AES-GCM). With no connection, signing in with the same email and
// password unlocks it; a wrong password cannot. Up to 15 people per device
// (a shared shop phone). The shop computer doesn't need this: it checks
// passwords itself.
const KEY = 'ss_offline_logins_v1';
const MAX = 15;
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const available = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof localStorage !== 'undefined';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = (all) => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ } };

async function keyFor(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** After an online sign-in: keep this person's session for offline sign-in. */
export async function rememberLogin(email, password, token, user) {
  if (!available() || !email || !password || !token) return;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(password, salt);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ token, user })));
    const all = load();
    all[String(email).trim().toLowerCase()] = { salt: b64(salt), iv: b64(iv), data: b64(data), at: Date.now() };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    save(Object.fromEntries(keep));
  } catch { /* never block a normal sign-in */ }
}

/** No internet: returns { token, user } if the email + password match what was kept, else null. */
export async function offlineLogin(email, password) {
  if (!available()) return null;
  const entry = load()[String(email || '').trim().toLowerCase()];
  if (!entry) return null;
  try {
    const key = await keyFor(password, unb64(entry.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.iv) }, key, unb64(entry.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; } // wrong password
}

/** After a password change, or to stop offline sign-in for someone on this device. */
export function forgetLogin(email) {
  const all = load();
  delete all[String(email || '').trim().toLowerCase()];
  save(all);
}

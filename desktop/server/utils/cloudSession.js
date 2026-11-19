// Cloud sessions for people signed in on this shop computer.
//
// Some screens only exist online (credit applications, couriers, payouts,
// shop branding, transfers between branches...). To use them from the shop
// computer, the person's OWN cloud login is used, so the cloud applies its
// normal permissions to them. When someone signs in here with a password
// while the internet is up, we sign them in to the cloud too (staff accounts
// already sync between the two) and keep that token in memory only.

const axios = require('axios');

const sessions = new Map(); // local user id -> { token, at }
const MAX_AGE_MS = 6 * 24 * 3600 * 1000; // cloud tokens last 7 days

function cloudBase() {
  try {
    const { loadConfig } = require('../syncAgent');
    const c = loadConfig();
    return c.cloudEnabled && c.cloudUrl ? c.cloudUrl.replace(/\/$/, '') : null;
  } catch { return null; }
}

/** Fire-and-forget after a successful local password sign-in. Never blocks or fails the local sign-in. */
async function signInToCloud(localUserId, email, password, otp) {
  const base = cloudBase();
  if (!base || !localUserId) return;
  try {
    const { data } = await axios.post(`${base}/api/auth/admin/login`, { email, password, otp }, { timeout: 8000 });
    if (data?.token) sessions.set(localUserId, { token: data.token, at: Date.now() });
  } catch {
    // Offline, or the account isn't in the cloud yet: the online-only screens will say so.
  }
}

function tokenFor(localUserId) {
  const s = sessions.get(localUserId);
  if (!s) return null;
  if (Date.now() - s.at > MAX_AGE_MS) { sessions.delete(localUserId); return null; }
  return s.token;
}

function forget(localUserId) { sessions.delete(localUserId); }

module.exports = { signInToCloud, tokenFor, forget, cloudBase };

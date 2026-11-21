// Small, dependency-free protections for the shop computer's server, which
// every phone and till on the shop Wi-Fi can reach.

/** True when the request comes from this computer itself. */
function isLocal(req) {
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Sign-in attempts: at most 20 failed-or-not POSTs per device per 15 minutes
// (the shop computer's own window is not limited).
const WINDOW = 15 * 60 * 1000;
const MAX = 20;
const hits = new Map();
function authLimiter(req, res, next) {
  if (req.method !== 'POST' || isLocal(req)) return next();
  const ip = String(req.socket?.remoteAddress || '');
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW) {
    hits.set(ip, { start: now, n: 1 });
  } else if (++rec.n > MAX) {
    res.setHeader('Retry-After', Math.ceil((rec.start + WINDOW - now) / 1000));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW) hits.delete(k);
  next();
}

module.exports = { isLocal, authLimiter };

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Auth endpoints (login/signup/invite-redeem) are the highest-value target for
// credential stuffing / brute force, so they get a tighter limit than the
// general API. Keyed by IP, which is why `app.set('trust proxy', ...)` in
// server.js matters — without it, every request behind a reverse proxy
// (Render/Railway/Fly/etc.) looks like it's coming from the same IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// A looser general-purpose limiter for the rest of the API, mainly to blunt
// scripted abuse rather than to constrain normal store usage. Signed-in
// requests are counted per session token, not per IP: every till in a shop
// usually shares one public IP, so an IP limit would lock a busy store out.
const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-store-sync-key'] || '');
};
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => {
    const tok = bearer(req);
    return tok ? `t:${crypto.createHash('sha256').update(tok).digest('hex').slice(0, 24)}` : `ip:${req.ip}`;
  },
  max: (req) => (bearer(req) ? 3000 : 900),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { authLimiter, apiLimiter };

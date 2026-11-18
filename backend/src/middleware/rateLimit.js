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
// scripted abuse rather than to constrain normal store usage.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { authLimiter, apiLimiter };

// ------------------------------------------------------------
// TOTP (RFC 6238) two-factor codes, implemented on Node's built-in
// crypto — works with any authenticator app (Google Authenticator,
// Microsoft Authenticator, Authy, 1Password, Aegis…). No SMS gateway,
// no third-party service, no licence.
// ------------------------------------------------------------
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

function generateCode(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 30000));
}

/** Accepts the current 30s window plus one either side (clock drift). */
function verifyCode(secret, code, time = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || '').trim())) return false;
  const c = String(code).trim();
  const step = Math.floor(time / 30000);
  for (const d of [-1, 0, 1]) {
    const expected = hotp(secret, step + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

function otpauthUrl({ secret, label, issuer = 'SAFE Stores' }) {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, generateCode, verifyCode, otpauthUrl, base32Encode, base32Decode };

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)

function randomCode(length = 8) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Invite codes look like INV-XXXXXXXX */
function generateInviteCode() {
  return `INV-${randomCode(8)}`;
}

/** Access codes look like ACC-XXXX-XXXX */
function generateAccessCode() {
  return `ACC-${randomCode(4)}-${randomCode(4)}`;
}

module.exports = { randomCode, generateInviteCode, generateAccessCode };

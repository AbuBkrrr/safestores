const jwt = require('jsonwebtoken');
const { config } = require('../config');

const SECRET = config.jwtSecret;
const EXPIRES_IN = '30d'; // desktop app — long-lived local session is fine

/**
 * payload shape:
 *  { sub: userId, storeId, role: 'super_admin'|'admin'|'manager'|'staff'|'auditor' }
 */
function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken };

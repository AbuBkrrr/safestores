// Minimal, user-friendly password policy (NIST 800-63B style): length
// matters far more than character-class rules, and a short blocklist of
// the most common passwords catches the worst choices.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', '11111111', '00000000', 'iloveyou', 'admin123', 'welcome1', 'abc12345', 'letmein1',
]);

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common — please choose another.';
  return null;
}

module.exports = { checkPassword };

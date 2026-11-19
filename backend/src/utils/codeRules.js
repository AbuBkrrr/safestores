// Validation shared by the access-code and tier endpoints (cloud + desktop keep identical copies).

/** Access-code lifetime in days: whole number 1–365, default 30. */
function parseExpiryDays(value) {
  if (value === undefined || value === null || value === '') return { value: 30 };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) return { error: 'expiresInDays must be a whole number from 1 to 365' };
  return { value: n };
}

/** Tier limits: blank/null means unlimited, otherwise a whole number ≥ 1. */
function parseTierLimits(body) {
  const limit = (v, name) => {
    if (v === undefined || v === null || v === '') return { value: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return { error: `${name} must be a whole number of at least 1, or blank for unlimited` };
    return { value: n };
  };
  const p = limit(body.maxProducts, 'maxProducts');
  if (p.error) return p;
  const u = limit(body.maxUsers, 'maxUsers');
  if (u.error) return u;
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : null;
  return { label, maxProducts: p.value, maxUsers: u.value };
}

module.exports = { parseExpiryDays, parseTierLimits };

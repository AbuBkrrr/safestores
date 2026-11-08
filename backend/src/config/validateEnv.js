// ------------------------------------------------------------
// Fail-fast environment validation.
//
// Rationale: a JWT_SECRET that's missing/empty, or CORS falling back to
// wildcard '*', are the kind of thing that "works" in local dev and then
// quietly breaks or exposes the API in production. Better to refuse to
// boot than to boot wrong.
// ------------------------------------------------------------

function validateEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const problems = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    problems.push('JWT_SECRET is missing or too short (use a long random string, 32+ chars recommended).');
  }
  if (process.env.JWT_SECRET === 'change_this_to_a_long_random_string') {
    problems.push('JWT_SECRET is still set to the .env.example placeholder value.');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL is missing.');
  }

  if (isProd) {
    if (!process.env.FRONTEND_URL) {
      problems.push('FRONTEND_URL must be set in production (CORS otherwise has nothing safe to allow).');
    }
    if (process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD === 'ChangeMe123!') {
      problems.push('BOOTSTRAP_SUPER_ADMIN_PASSWORD is still the .env.example placeholder — change it before going live.');
    }
  }

  if (problems.length) {
    console.error('\n✖ Refusing to start — configuration problems:\n');
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('\nFix these in your .env (or host\'s environment variables) and restart.\n');
    process.exit(1);
  }
}

module.exports = { validateEnv };

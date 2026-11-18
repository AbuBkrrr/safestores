// Runs once before the entire test suite. Applies migrations to the
// dedicated safestores_jest database (env vars for that DB are set in the
// "test" npm script, not read from .env, so this never touches dev data).
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function globalSetup() {
  execFileSync('node', [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
    stdio: 'inherit',
    env: process.env,
  });
};

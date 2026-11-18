const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// Desktop end users never edit config files by hand, so instead of a .env
// with a JWT secret, we generate one automatically on first launch and
// persist it alongside the database. Same effect, zero setup required.
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadOrCreateConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
}

const config = loadOrCreateConfig();

module.exports = { config, configPath };

const os = require('os');
const fs = require('fs');
const path = require('path');

// server/db.js and server/config.js both call electron's app.getPath('userData')
// at module-load time to find where to put the SQLite file / auto-generated
// JWT secret. Outside a real Electron process (i.e. under Jest) that module
// doesn't behave like a running app, so this mock stands in for it — each
// Jest test FILE gets its own fresh temp directory (module registry is
// isolated per file by default), which conveniently also means each test
// file gets its own on-disk SQLite database with zero cross-file pollution.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safestores-test-'));

module.exports = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return tmpDir;
      return tmpDir;
    },
  },
};

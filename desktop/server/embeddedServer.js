// The embedded server (and its SQLite database) must only be created after
// Electron's `app` module is ready, since server/db.js calls app.getPath().
// Split out from main.js so this real, testable logic (port binding with
// a fallback if the default port is taken) can be unit tested directly,
// without requiring main.js itself — which runs real Electron window/menu
// lifecycle code (app.whenReady, BrowserWindow, Menu) at module load time
// that only a real Electron runtime can execute.
const DEFAULT_PORT = 4500;

function startEmbeddedServer(port = DEFAULT_PORT) {
  const { createApp } = require('./app');
  const expressApp = createApp();

  return new Promise((resolve, reject) => {
    // Bind to all interfaces (0.0.0.0), not just loopback — this is what
    // lets other devices on the same Wi-Fi (a LAN peer, or a phone using
    // this device as its sync relay) actually reach this server. Binding
    // to 127.0.0.1 only would make LAN sync silently impossible.
    let server = expressApp.listen(port, '0.0.0.0', () => {
      resolve({ port, server });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Fall back to a random free port if the default is taken (e.g. a
        // second instance on the same machine during development).
        server = expressApp.listen(0, '0.0.0.0', () => resolve({ port: server.address().port, server }));
      } else {
        reject(err);
      }
    });
  });
}

module.exports = { startEmbeddedServer, DEFAULT_PORT };

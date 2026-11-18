// Playwright's Electron mode — this is the ONE piece of the desktop app
// that jest+mocked-electron (tests/) genuinely can't cover: the real
// window/menu lifecycle (app.whenReady, BrowserWindow, Menu), which needs
// a real Electron runtime, not a mock. Uses the app's own bundled
// Electron binary directly — no browser download needed, unlike
// Playwright's usual Chromium/Firefox/WebKit modes.
module.exports = {
  testDir: './e2e',
  timeout: 30000,
  workers: 1, // each test launches a real Electron process — run sequentially
  reporter: 'list',
};

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test gets a fully isolated userData dir (fresh SQLite db, fresh
// config.json) — otherwise consecutive test runs would share state and a
// real store/super-admin would persist across tests, exactly the kind of
// cross-test pollution the jest suite's electron mock avoids by giving
// each test FILE its own temp dir.
function freshUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safestores-e2e-'));
}

async function launchApp() {
  const userDataDir = freshUserDataDir();
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'main.js'),
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox', // required to run Electron as root in this environment
    ],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  return { app, userDataDir };
}

test('the app launches, opens a real window, and loads the real frontend (not a crash/blank page)', async () => {
  const { app, userDataDir } = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    expect(title).toBe('SAFE Stores — Enterprise Inventory System'); // Electron adopts document.title once the page loads

    // Proves this is the REAL frontend build being served through the
    // embedded Express server (server/app.js's static + catch-all route),
    // not an error page — the Setup page is what a truly first-run
    // install (no super admin yet) should land on.
    await expect(window.locator('body')).toContainText(/Setup|Create.*Super Admin|Welcome/i, { timeout: 10000 });
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the embedded server is reachable directly (not just through the window) and returns real data', async () => {
  const { app, userDataDir } = await launchApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Ask the window itself (which knows the real bound port — it can be
    // a fallback port, not always 4500) to fetch the currency endpoint,
    // proving the real server/db.js SQLite database and server/app.js
    // Express app are both alive inside this real Electron process, not
    // just that a window opened.
    const apiResult = await window.evaluate(async () => {
      const res = await fetch('/api/settings/currency');
      return { status: res.status, body: await res.json() };
    });
    expect(apiResult.status).toBe(200);
    expect(apiResult.body.code).toBe('NGN');
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('the application menu is built with the expected top-level items', async () => {
  const { app, userDataDir } = await launchApp();
  try {
    await app.firstWindow();
    const menuLabels = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      return menu ? menu.items.map((i) => i.label) : null;
    });
    expect(menuLabels).toEqual(['File', 'View']);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('closing the window cleanly stops the app without hanging (background jobs shut down)', async () => {
  const { app, userDataDir } = await launchApp();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const closePromise = app.close(); // window-all-closed handler stops all 6 background job intervals + closes the HTTP server
  await expect(closePromise).resolves.toBeUndefined();

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('a second real user-data directory gets an independent, isolated database', async () => {
  const first = await launchApp();
  try {
    const win1 = await first.app.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    // Create the first super admin via the real UI-facing API, through the real window.
    await win1.evaluate(async () => {
      await fetch('/api/setup/super-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'E2E Admin', email: 'e2e@test.com', password: 'E2ePassword123!' }),
      });
    });
    const status1 = await win1.evaluate(async () => (await (await fetch('/api/setup/status')).json()));
    expect(status1.needsSetup).toBe(false);
  } finally {
    await first.app.close();
    fs.rmSync(first.userDataDir, { recursive: true, force: true });
  }

  // A fresh install (new userData dir) must NOT see that super admin —
  // proves real per-install data isolation, the same thing the backup/
  // sync tests care about but confirmed here through a real second
  // Electron process launch, not just a second SQLite file on disk.
  const second = await launchApp();
  try {
    const win2 = await second.app.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    const status2 = await win2.evaluate(async () => (await (await fetch('/api/setup/status')).json()));
    expect(status2.needsSetup).toBe(true);
  } finally {
    await second.app.close();
    fs.rmSync(second.userDataDir, { recursive: true, force: true });
  }
});

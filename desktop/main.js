const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const { startEmbeddedServer } = require('./server/embeddedServer');
const errorMonitoring = require('./server/errorMonitoring');

errorMonitoring.init(); // safe no-op if SENTRY_DSN isn't set — see that file

// Catches crashes in the Electron main process itself — window creation,
// menu building, the background job intervals — not just the embedded
// Express server (app.js wires its own handler for that). A crash here
// takes down the whole app for that store with nothing else watching,
// so this matters more on desktop than the equivalent in the cloud
// backend, which typically runs behind a process manager that restarts it.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  errorMonitoring.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  errorMonitoring.captureException(err);
});

let mainWindow;
let httpServer;
let stopSyncAgent;
let stopBillingJob;
let stopBackupJob;
let stopReplenishmentJob;
let stopExpiryJob;
let stopCycleCountJob;

async function createWindow() {
  const { port, server } = await startEmbeddedServer();
  httpServer = server;

  const realtime = require('./server/realtime');
  realtime.init(httpServer);

  const { startSyncAgent } = require('./server/syncAgent');
  stopSyncAgent = startSyncAgent(port);

  const { startBillingJob } = require('./server/billingJob');
  stopBillingJob = startBillingJob();

  const { startBackupJob } = require('./server/backupJob');
  stopBackupJob = startBackupJob();

  const { startReplenishmentJob } = require('./server/replenishmentJob');
  stopReplenishmentJob = startReplenishmentJob();

  const { startExpiryJob } = require('./server/expiryJob');
  stopExpiryJob = startExpiryJob();

  const { startCycleCountJob } = require('./server/cycleCountJob');
  stopCycleCountJob = startCycleCountJob();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: app.getName(), // the store's own name in a store build (templates/store-app)
    backgroundColor: '#0f7180',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  const appOrigin = `http://127.0.0.1:${port}`;
  mainWindow.loadURL(`${appOrigin}/`);

  // Print windows (receipts, labels, repair tags, handover slips) open as a
  // blank page the app fills in, so they must stay inside the app; real web
  // links (WhatsApp, invite sharing) go to the user's default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 760, autoHideMenuBar: true, title: 'Print' } };
    }
    if (/^https?:\/\//i.test(url) && !url.startsWith(appOrigin)) shell.openExternal(url);
    return { action: 'deny' };
  });

  allowReceiptPrinters(mainWindow);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Lets the till talk to USB, serial and Bluetooth receipt printers. Electron
// has no built-in device picker, so these choose for the user: the first
// printer-class USB device, the first serial port, and for Bluetooth the
// first device that looks like a receipt printer (or the first one found).
const PRINTER_NAME = /print|pos|receipt|thermal|xp-|pt-|mtp|rpp|zj|gp-|hm-|bt/i;
function allowReceiptPrinters(win) {
  const ses = win.webContents.session;
  const trusted = (origin) => /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(String(origin || '').replace(/\/$/, ''));
  ses.setPermissionCheckHandler((wc, permission, origin) => (
    ['serial', 'usb', 'hid', 'bluetooth'].includes(permission) ? trusted(origin) : true
  ));
  ses.setDevicePermissionHandler((details) => trusted(details.origin));
  ses.on('select-serial-port', (event, ports, wc, callback) => {
    event.preventDefault();
    callback(ports[0]?.portId || '');
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId);
  });
  let pending = null;
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (!pending) {
      pending = { callback, timer: setTimeout(() => { const p = pending; pending = null; p.callback(p.first || ''); }, 8000) };
    }
    pending.first = pending.first || devices[0]?.deviceId;
    const hit = devices.find((d) => PRINTER_NAME.test(d.deviceName || ''));
    if (hit) { clearTimeout(pending.timer); const p = pending; pending = null; p.callback(hit.deviceId); }
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (stopSyncAgent) stopSyncAgent();
  if (stopBillingJob) stopBillingJob();
  if (stopBackupJob) stopBackupJob();
  if (stopReplenishmentJob) stopReplenishmentJob();
  if (stopExpiryJob) stopExpiryJob();
  if (stopCycleCountJob) stopCycleCountJob();
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});

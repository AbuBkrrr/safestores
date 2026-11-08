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
    title: 'SAFE Stores',
    backgroundColor: '#0f7180',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Open any target="_blank" links (e.g. from invite-sharing buttons) in the
  // user's default browser instead of inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
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

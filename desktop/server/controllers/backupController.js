const fs = require('fs');
const path = require('path');
const { dialog, app } = require('electron');
const { runBackup, listBackups } = require('../backupJob');
const db = require('../db');

// GET /api/super/backups — or store-admin-facing, see routes wiring
function list(req, res) {
  res.json(listBackups());
}

// POST /api/super/backups/run — manual "Backup Now"
async function runNow(req, res) {
  try {
    const dest = await runBackup();
    res.status(201).json({ message: 'Backup created', path: dest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Backup failed' });
  }
}

// POST /api/super/backups/:name/save-to
// Opens a native "Save As" dialog so the admin can copy a backup onto a
// USB drive, network share, or cloud-synced folder — the actual
// off-machine step that makes a backup useful against theft/fire/disk
// failure, not just corruption/accidental deletion.
async function saveTo(req, res) {
  const { name } = req.params;
  const backups = listBackups();
  const backup = backups.find((b) => b.name === name);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save Backup Copy',
    defaultPath: name,
    filters: [{ name: 'SAFE Stores Backup', extensions: ['db'] }],
  });
  if (canceled || !filePath) return res.status(200).json({ message: 'Cancelled' });

  fs.copyFileSync(backup.path, filePath);
  res.json({ message: `Backup saved to ${filePath}` });
}

// POST /api/super/backups/restore
// Opens a native "Open" dialog to pick a .db backup file, then restores
// it. Restoring requires the app to fully restart with the database
// connection closed first — this response tells the renderer to show a
// "restoring, app will restart" message, then main.js relaunches.
async function restore(req, res) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Restore From Backup',
    filters: [{ name: 'SAFE Stores Backup', extensions: ['db'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return res.status(200).json({ message: 'Cancelled' });

  const chosen = filePaths[0];
  // Sanity check it's at least a SQLite file before we commit to overwriting
  // the live database with it.
  const header = Buffer.alloc(16);
  const fd = fs.openSync(chosen, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    return res.status(400).json({ error: 'That file does not look like a valid backup' });
  }

  // Take one last safety backup of the CURRENT (about-to-be-replaced)
  // database before overwriting it, in case the chosen file was the wrong
  // one — this makes restore itself un-done-able rather than a one-way
  // door.
  await runBackup();

  const liveDbPath = db.dbPath;
  db.close();
  fs.copyFileSync(chosen, liveDbPath);

  res.json({ message: 'Restored. The app will now restart to load the restored data.' });
  setTimeout(() => { app.relaunch(); app.exit(); }, 800);
}

module.exports = { list, runNow, saveTo, restore };

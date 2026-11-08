// ------------------------------------------------------------
// Automated local backups — this is a genuine gap otherwise: the desktop
// edition's entire store (products, orders, users, everything) lives in
// ONE SQLite file on ONE machine. Without this, a failed disk, corrupted
// file, or accidental deletion means permanent, total data loss, and the
// only existing safety net (manual CSV/JSON export) requires an admin to
// remember to run it and often saves right back onto the same machine.
//
// What this provides:
//   - A daily rotating backup (keeps the last KEEP_COUNT), taken with
//     better-sqlite3's built-in .backup() — a safe hot-copy that doesn't
//     require pausing writes or risk copying a mid-write/corrupt file the
//     way a naive fs.copyFile of a live SQLite file could.
//   - A manual "Backup Now" trigger for before something risky (e.g.
//     before a bulk import) — see backupController.js.
//   - "Save a copy to..." using Electron's native save dialog, so an
//     owner can actually get a backup onto a USB drive or network share —
//     true off-site protection still requires the owner to do this
//     periodically, or to configure cloud sync (see syncAgent.js); this
//     doesn't (and can't) protect against the machine itself being
//     stolen/destroyed if backups only ever stay on that same machine.
// ------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const db = require('./db');

const KEEP_COUNT = 14;

function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampedName() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-07-20T11-30-00
  return `safestores-backup-${stamp}.db`;
}

/** Takes a backup right now. Returns the full path written. */
async function runBackup() {
  const dest = path.join(backupDir(), timestampedName());
  await db.backup(dest); // better-sqlite3's built-in safe hot-backup
  rotateOldBackups();
  return dest;
}

function rotateOldBackups() {
  const dir = backupDir();
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('safestores-backup-') && f.endsWith('.db'))
    .map((f) => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  for (const old of files.slice(KEEP_COUNT)) {
    fs.unlinkSync(path.join(dir, old.name));
  }
}

function listBackups() {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('safestores-backup-') && f.endsWith('.db'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

let lastBackupDate = null;

/** Runs once a day automatically — checked every hour, only actually
 * backs up once the calendar date has changed since the last one, so it
 * survives the app not running at a fixed time (same reasoning as
 * billingJob.js's catch-up-on-launch approach). */
function startBackupJob() {
  const check = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastBackupDate) {
      try {
        await runBackup();
        lastBackupDate = today;
        console.log('[backup] daily backup completed');
      } catch (err) {
        console.error('[backup] failed:', err.message);
      }
    }
  };
  check(); // catch up immediately on launch
  const interval = setInterval(check, 60 * 60 * 1000);
  return () => clearInterval(interval);
}

module.exports = { runBackup, listBackups, backupDir, startBackupJob };

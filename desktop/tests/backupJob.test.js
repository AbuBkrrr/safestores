const fs = require('fs');
const path = require('path');
const { app } = require('electron'); // the mocked module
const { runBackup, listBackups, backupDir } = require('../server/backupJob');
const { createStore } = require('./helpers/factories');

describe('backupJob: runBackup', () => {
  it('writes a real, openable SQLite backup file containing the current data', async () => {
    await createStore({ name: 'Backup Target Store' });

    const dest = await runBackup();

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);

    // Prove it's a real, valid, independently-openable SQLite file with
    // the data at the time of backup — not just an empty/corrupt copy.
    const Database = require('better-sqlite3');
    const backupDb = new Database(dest, { readonly: true });
    const row = backupDb.prepare('SELECT name FROM stores WHERE name = ?').get('Backup Target Store');
    expect(row).toBeTruthy();
    backupDb.close();
  });

  it('creates the backups directory on first use', () => {
    const dir = backupDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('listBackups reflects a newly written backup, most recent first', async () => {
    await createStore();
    const before = listBackups().length;
    await new Promise((r) => setTimeout(r, 1100)); // filenames are second-granularity timestamps
    await runBackup();

    const after = listBackups();
    expect(after.length).toBe(before + 1);
    expect(after[0].sizeBytes).toBeGreaterThan(0);
    expect(new Date(after[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(after[after.length - 1].createdAt).getTime());
  });
});

describe('backupJob: rotation (keeps only the most recent 14)', () => {
  it('deletes the oldest backups once more than 14 exist', async () => {
    await createStore();
    const dir = backupDir();

    // Create 16 fake backup files directly (bypassing the 1s-apart timing
    // real runBackup calls would need) with distinct, controllable mtimes.
    for (let i = 0; i < 16; i++) {
      const p = path.join(dir, `safestores-backup-fake-${i}.db`);
      fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - (16 - i) * 60000); // each one minute apart, ascending
      fs.utimesSync(p, t, t);
    }

    await runBackup(); // triggers rotateOldBackups() as a side effect

    const remaining = listBackups();
    expect(remaining.length).toBeLessThanOrEqual(14);
  });
});

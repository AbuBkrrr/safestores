// Repair shops offline: check in a customer's car or device with a QR tag,
// work on it with notes, and hand it back only against its own tag.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const db = require('../server/db');
const { applySchemaUpgrades } = require('../server/schemaUpgrades');

describe('Repair jobs with QR-tagged items (offline)', () => {
  it('checks in a device, opens it by its tag, records diagnosis, notes and parts, and refuses the wrong tag at hand-back', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const A = { Authorization: `Bearer ${token}` };
    const call = (m, p, b) => request()[m](`/api/stores/${store.id}${p}`).set(A).send(b);
    await call('patch', '/settings', { businessType: 'tech_repair' });
    const battery = createProduct(store.id, { name: 'Laptop battery', costPrice: 30000, backroomQty: 2 });

    const job = await call('post', '/jobs', {
      customerName: 'Ada Obi', customerPhone: '0802', title: 'Laptop not powering on', items: [{ description: 'Repair', quantity: 1, price: 40000 }],
      itemDetails: { kind: 'Laptop', make: 'HP', model: 'EliteBook 840', serial: '5CG1234XYZ' }, fault: 'Dead', condition: 'Hinge loose', accessories: 'Charger',
    });
    expect(job.status).toBe(201);
    const tag = job.body.tag_code;
    expect(tag).toMatch(/^T[A-Z2-9]{6}$/);
    expect(job.body.item_details).toMatchObject({ make: 'HP', serial: '5CG1234XYZ' });

    expect((await call('get', `/jobs/tag/${encodeURIComponent(`http://shop/jobs?tag=${tag}`)}`)).body.id).toBe(job.body.id);
    expect((await call('get', '/jobs?q=5cg1234')).body[0].id).toBe(job.body.id);
    expect((await call('patch', `/jobs/${job.body.id}/status`, { status: 'awaiting_approval' })).body.status).toBe('awaiting_approval');
    expect((await call('patch', `/jobs/${job.body.id}/repair`, { diagnosis: 'Battery swollen' })).body.diagnosis).toBe('Battery swollen');
    expect((await call('post', `/jobs/${job.body.id}/notes`, { note: 'Customer said go ahead' })).body.notes_log[0].note).toBe('Customer said go ahead');
    await call('post', `/jobs/${job.body.id}/materials`, { productId: battery.id, quantity: 1 });

    expect((await call('post', `/jobs/${job.body.id}/collect`, { tagCode: 'TWRONG2' })).body.code).toBe('WRONG_ITEM');
    expect((await call('post', `/jobs/${job.body.id}/collect`, { tagCode: tag, method: 'cash' })).body).toMatchObject({ status: 'collected', balancePaid: 40000 });

    const exp = await request().get(`/api/stores/${store.id}/sync/export`).set('x-store-sync-key', db.prepare('SELECT sync_key FROM stores WHERE id = ?').get(store.id).sync_key);
    expect(exp.body.jobs[0]).toMatchObject({ tag_code: tag, diagnosis: 'Battery swollen' });
    expect(exp.body.jobNotes).toHaveLength(1);
  });

  it('upgrading a shop computer that has the old job table keeps every job and allows the new statuses', () => {
    const { store } = createActiveStoreWithAdmin();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS job_notes; DROP TABLE IF EXISTS job_payments; DROP TABLE IF EXISTS job_materials; DROP TABLE job_orders');
    db.exec(`CREATE TABLE job_orders (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, ref TEXT NOT NULL, store_customer_id TEXT, customer_name TEXT NOT NULL,
      customer_phone TEXT, title TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', measurements TEXT NOT NULL DEFAULT '{}', total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled')),
      due_date TEXT, notes TEXT, assigned_to TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, collected_at TEXT, UNIQUE (store_id, ref))`);
    db.prepare("INSERT INTO job_orders (id, store_id, ref, customer_name, title, total, status) VALUES ('old-1', ?, 'J000001', 'Old customer', 'Old job', 5000, 'ready')").run(store.id);
    db.exec('PRAGMA foreign_keys = ON');

    applySchemaUpgrades(db);
    expect(db.prepare("SELECT customer_name, total, status FROM job_orders WHERE id = 'old-1'").get()).toEqual({ customer_name: 'Old customer', total: 5000, status: 'ready' });
    expect(() => db.prepare("UPDATE job_orders SET status = 'waiting_parts' WHERE id = 'old-1'").run()).not.toThrow();
    applySchemaUpgrades(db); // running again changes nothing
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_orders').get().n).toBe(1);
  });
});

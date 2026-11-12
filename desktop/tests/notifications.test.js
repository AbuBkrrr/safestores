const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor, createSuperAdmin, superToken } = require('./helpers/factories');
const db = require('../server/db');

function insertNotification(storeId, type, message) {
  db.prepare(`INSERT INTO notifications (id, type, store_id, message) VALUES (?,?,?,?)`).run(crypto.randomUUID(), type, storeId, message);
}

function insertStoreNotification(storeId, { audienceRole, userId, type = 'po_created', message = 'X' }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO store_notifications (id, store_id, type, audience_role, user_id, message) VALUES (?,?,?,?,?,?)`
  ).run(id, storeId, type, audienceRole || null, userId || null, message);
  return id;
}

describe('Super Admin Notifications', () => {
  it('lists notifications and reports unread count', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    insertNotification(store.id, 'payment_claim', 'Test');

    const list = await request().get('/api/super/notifications').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const count = await request().get('/api/super/notifications/unread-count').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(count.body.count).toBe(1);
  });

  it('dismisses a single notification', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    insertNotification(store.id, 'payment_claim', 'Test');
    const row = db.prepare('SELECT id FROM notifications WHERE store_id = ?').get(store.id);

    const res = await request().patch(`/api/super/notifications/${row.id}/dismiss`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(200);

    const count = await request().get('/api/super/notifications/unread-count').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(count.body.count).toBe(0);
  });

  it('dismiss-all clears the unread count', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    insertNotification(store.id, 'payment_claim', 'A');
    insertNotification(store.id, 'overdue_warning', 'B');

    const res = await request().patch('/api/super/notifications/dismiss-all').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(200);

    const count = await request().get('/api/super/notifications/unread-count').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(count.body.count).toBe(0);
  });

  it('a non-super-admin cannot read super notifications', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().get('/api/super/notifications').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('Store Notifications', () => {
  it('admin sees store-wide (audience_role=admin) notifications', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    insertStoreNotification(store.id, { audienceRole: 'admin', message: 'A PO was created' });

    const res = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
  });

  it('a non-admin only sees notifications addressed to them personally', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff1 = await createUser(store.id, { role: 'staff' });
    const staff2 = await createUser(store.id, { role: 'staff' });
    insertStoreNotification(store.id, { userId: staff1.id, type: 'recount_needed', message: 'Recount for you' });
    insertStoreNotification(store.id, { audienceRole: 'admin', message: 'Admin only' });

    const res1 = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${tokenFor(staff1)}`);
    expect(res1.body.notifications).toHaveLength(1);

    const res2 = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${tokenFor(staff2)}`);
    expect(res2.body.notifications).toHaveLength(0);
  });

  it('marks a notification read', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const id = insertStoreNotification(store.id, { audienceRole: 'admin' });

    const res = await request().patch(`/api/stores/${store.id}/notifications/${id}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('read');

    const list = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${token}`);
    expect(list.body.unreadCount).toBe(0);
  });
});

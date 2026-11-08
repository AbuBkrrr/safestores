const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor, createSuperAdmin, superToken } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Super Admin Notifications', () => {
  it('lists notifications and reports unread count', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    await pool.query(`INSERT INTO notifications (type, store_id, message) VALUES ('payment_claim', $1, 'Test')`, [store.id]);

    const list = await request().get('/api/super/notifications').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const count = await request().get('/api/super/notifications/unread-count').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(count.body.count).toBe(1);
  });

  it('dismisses a single notification', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    const { rows } = await pool.query(`INSERT INTO notifications (type, store_id, message) VALUES ('payment_claim', $1, 'Test') RETURNING *`, [store.id]);

    const res = await request().patch(`/api/super/notifications/${rows[0].id}/dismiss`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(200);

    const count = await request().get('/api/super/notifications/unread-count').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(count.body.count).toBe(0);
  });

  it('dismiss-all clears the unread count', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    await pool.query(`INSERT INTO notifications (type, store_id, message) VALUES ('payment_claim', $1, 'A'), ('overdue_warning', $1, 'B')`, [store.id]);

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
    await pool.query(
      `INSERT INTO store_notifications (store_id, type, audience_role, message) VALUES ($1, 'po_created', 'admin', 'A PO was created')`,
      [store.id]
    );

    const res = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
  });

  it('a non-admin only sees notifications addressed to them personally', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff1 = await createUser(store.id, { role: 'staff' });
    const staff2 = await createUser(store.id, { role: 'staff' });
    await pool.query(
      `INSERT INTO store_notifications (store_id, type, user_id, message) VALUES ($1, 'recount_needed', $2, 'Recount for you')`,
      [store.id, staff1.id]
    );
    // A store-wide admin-audience notification should NOT show for staff either.
    await pool.query(
      `INSERT INTO store_notifications (store_id, type, audience_role, message) VALUES ($1, 'po_created', 'admin', 'Admin only')`,
      [store.id]
    );

    const res1 = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${tokenFor(staff1)}`);
    expect(res1.body.notifications).toHaveLength(1);

    const res2 = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${tokenFor(staff2)}`);
    expect(res2.body.notifications).toHaveLength(0);
  });

  it('marks a notification read', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const { rows } = await pool.query(
      `INSERT INTO store_notifications (store_id, type, audience_role, message) VALUES ($1, 'po_created', 'admin', 'X') RETURNING *`,
      [store.id]
    );

    const res = await request().patch(`/api/stores/${store.id}/notifications/${rows[0].id}/read`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('read');

    const list = await request().get(`/api/stores/${store.id}/notifications`).set('Authorization', `Bearer ${token}`);
    expect(list.body.unreadCount).toBe(0);
  });
});

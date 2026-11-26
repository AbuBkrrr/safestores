const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Job titles that fit the business', () => {
  it('a restaurant invites a Chef and a Waiter; titles reach sign-in and the staff list', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query("UPDATE stores SET store_tier = 'mini', business_type = 'restaurant' WHERE id = $1", [store.id]);
    const A = { Authorization: `Bearer ${token}` };
    const chef = await request().post(`/api/stores/${store.id}/invites`).set(A).send({ name: 'Bayo', role: 'staff', jobTitle: 'chef' });
    expect(chef.status).toBe(201);
    expect(chef.body.job_title).toBe('chef');
    const waiter = await request().post(`/api/stores/${store.id}/invites`).set(A).send({ name: 'Zainab', role: 'checkout', jobTitle: 'waiter' });
    expect(waiter.status).toBe(201); // a Mini restaurant can have a waiter

    const login = await request().post('/api/auth/invite/login').send({ code: chef.body.code });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'staff', jobTitle: 'chef' });

    const users = await request().get(`/api/stores/${store.id}/users`).set(A);
    const bayo = users.body.find((u) => u.name === 'Bayo');
    expect(bayo.job_title).toBe('chef');
    const re = await request().patch(`/api/stores/${store.id}/users/${bayo.id}/title`).set(A).send({ jobTitle: 'kitchen_assistant' });
    expect(re.body.job_title).toBe('kitchen_assistant');
  });
});

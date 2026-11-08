const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createSuperAdmin, superToken } = require('./helpers/factories');

describe('Support Tickets: store side', () => {
  it('creates a ticket and lists it', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Cannot print receipts', message: 'The receipt printer is not responding', priority: 'high' });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('open');

    const list = await request().get(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
  });

  it('rejects a ticket with no message', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`).send({ subject: 'X' });
    expect(res.status).toBe(400);
  });

  it('a store admin replies, reopening the ticket to "open"', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const superAdmin = await createSuperAdmin();
    const created = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`)
      .send({ subject: 'X', message: 'Y' });
    // Move it forward first so we can see the reply resets it to 'open'.
    await request().patch(`/api/super/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ status: 'resolved' });

    const reply = await request().post(`/api/stores/${store.id}/support/tickets/${created.body.id}/reply`)
      .set('Authorization', `Bearer ${token}`).send({ message: 'Still broken, please help' });
    expect(reply.status).toBe(201);

    const ticket = await request().get(`/api/stores/${store.id}/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(ticket.body.status).toBe('open');
    expect(ticket.body.replies).toHaveLength(1);
  });

  it('a store cannot see another store\'s ticket', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${other.store.id}/support/tickets`).set('Authorization', `Bearer ${other.token}`)
      .send({ subject: 'X', message: 'Y' });

    const res = await request().get(`/api/stores/${store.id}/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('Support Tickets: super admin side', () => {
  it('lists tickets across all stores, filterable by status', async () => {
    const superAdmin = await createSuperAdmin();
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`).send({ subject: 'X', message: 'Y' });

    const res = await request().get('/api/super/support/tickets?status=open').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('store_name');
  });

  it('updates ticket status', async () => {
    const superAdmin = await createSuperAdmin();
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`).send({ subject: 'X', message: 'Y' });

    const res = await request().patch(`/api/super/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  });

  it('rejects an invalid status transition value', async () => {
    const superAdmin = await createSuperAdmin();
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`).send({ subject: 'X', message: 'Y' });

    const res = await request().patch(`/api/super/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ status: 'banana' });
    expect(res.status).toBe(400);
  });

  it('super admin replies, moving status to "in_progress" and attributing the author name', async () => {
    const superAdmin = await createSuperAdmin({ name: 'Support Sam' });
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`).send({ subject: 'X', message: 'Y' });

    const reply = await request().post(`/api/super/support/tickets/${created.body.id}/reply`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ message: 'We are looking into it' });
    expect(reply.status).toBe(201);
    expect(reply.body.author_name).toBe('Support Sam');
    expect(reply.body.author_type).toBe('super_admin');

    const ticket = await request().get(`/api/super/support/tickets/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(ticket.body.status).toBe('in_progress');
  });
});

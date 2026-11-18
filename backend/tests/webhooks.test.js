const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const { dispatchEvent } = require('../src/utils/webhooks');

describe('Webhooks: config CRUD', () => {
  it('creates a webhook, returning the secret once', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid', 'not.a.real.event'] });

    expect(res.status).toBe(201);
    expect(res.body.events).toEqual(['order.paid']); // invalid event filtered out
    expect(res.body.secret).toEqual(expect.any(String));
  });

  it('rejects creation with no valid events', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/webhooks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['nonsense'] });

    expect(res.status).toBe(400);
  });

  it('lists webhooks without exposing the secret', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });

    const res = await request().get(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.webhooks).toHaveLength(1);
    expect(res.body.webhooks[0].secret).toBeUndefined();
    expect(res.body.webhooks[0].events).toEqual(['order.paid']);
    expect(res.body.availableEvents).toContain('receipt.applied');
  });

  it('updates a webhook\'s events', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });

    const res = await request()
      .patch(`/api/stores/${store.id}/webhooks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ events: ['receipt.applied', 'batch.expiring'] });

    expect(res.status).toBe(200);
    expect(res.body.events.sort()).toEqual(['batch.expiring', 'receipt.applied']);
  });

  it('soft-deletes a webhook, removing it from the list', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });

    const del = await request().delete(`/api/stores/${store.id}/webhooks/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request().get(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`);
    expect(list.body.webhooks).toHaveLength(0);

    // Row itself still exists (soft delete), just hidden — and dispatch must not target it.
    const { rows } = await pool.query('SELECT deleted_at FROM webhooks WHERE id = $1', [created.body.id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });
});

describe('Webhooks: dispatchEvent lookup (regression test for the array/JSON schema mismatch)', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('finds and fires an active hook subscribed to the event (JSON-column events)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });

    await dispatchEvent(store.id, 'order.paid', { total: 10 });
    await new Promise((r) => setTimeout(r, 50)); // let the un-awaited fetch promise settle

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/hook');
  });

  it('does not fire for a subscribed-but-inactive hook', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });
    await request().patch(`/api/stores/${store.id}/webhooks/${created.body.id}`).set('Authorization', `Bearer ${token}`)
      .send({ active: false });

    await dispatchEvent(store.id, 'order.paid', {});
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire for an event the hook is not subscribed to', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['receipt.applied'] });

    await dispatchEvent(store.id, 'order.paid', {});
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fire for a soft-deleted hook', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });
    await request().delete(`/api/stores/${store.id}/webhooks/${created.body.id}`).set('Authorization', `Bearer ${token}`);

    await dispatchEvent(store.id, 'order.paid', {});
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a real order.paid checkout event reaches a subscribed webhook end-to-end', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/webhooks`).set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://example.com/hook', events: ['order.paid'] });
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});

    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`).send({});
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

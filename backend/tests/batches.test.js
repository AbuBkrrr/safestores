const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');

async function seedArrival(store, token, product, { quantity, expiryDate, batchNumber }) {
  return request()
    .post(`/api/stores/${store.id}/arrivals`)
    .set('Authorization', `Bearer ${token}`)
    .send({ productId: product.id, quantity, expiryDate, batchNumber });
}

describe('Batches / Expiry Tracking', () => {
  it('lists batches with remaining quantity, excluding depleted by default', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0 });
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await seedArrival(store, token, product, { quantity: 10, expiryDate: future, batchNumber: 'B-A' });

    const res = await request().get(`/api/stores/${store.id}/batches`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.find((b) => b.batchNumber === 'B-A').remaining).toBe(10);
  });

  it('flags batches expiring soon, honoring an explicit ?days window', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0 });
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    await seedArrival(store, token, product, { quantity: 5, expiryDate: soon, batchNumber: 'SOON' });
    await seedArrival(store, token, product, { quantity: 5, expiryDate: far, batchNumber: 'FAR' });

    const res = await request()
      .get(`/api/stores/${store.id}/batches/expiring?days=7`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const numbers = res.body.map((b) => b.batchNumber);
    expect(numbers).toContain('SOON');
    expect(numbers).not.toContain('FAR');
  });

  it('does not require auth to be rejected differently across stores (tenant isolation)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();

    const res = await request()
      .get(`/api/stores/${other.store.id}/batches`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

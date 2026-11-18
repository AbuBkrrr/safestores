const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { createAuditStockTaker } = require('./helpers/factories');

describe('Stock Arrivals', () => {
  it('records an arrival and increases backroom quantity', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0 });

    const res = await request()
      .post(`/api/stores/${store.id}/arrivals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 15, invoiceNumber: 'INV-1' });

    expect(res.status).toBe(201);

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).backroom_qty).toBe(15);
  });

  it('rejects an arrival with zero/negative quantity', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/arrivals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 0 });

    expect(res.status).toBe(400);
  });

  it('creates a trackable batch when expiryDate is given', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const expiry = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);

    await request()
      .post(`/api/stores/${store.id}/arrivals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 5, expiryDate: expiry, batchNumber: 'B1' });

    const batches = await request().get(`/api/stores/${store.id}/batches`).set('Authorization', `Bearer ${token}`);
    expect(batches.status).toBe(200);
    expect(batches.body.some((b) => b.batchNumber === 'B1')).toBe(true);
  });

  it('an idempotent replay (same client id) is a safe no-op', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0 });
    const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', `Bearer ${token}`)
      .send({ id: clientId, productId: product.id, quantity: 10 });
    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', `Bearer ${token}`)
      .send({ id: clientId, productId: product.id, quantity: 10 });

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).backroom_qty).toBe(10); // not 20
  });
});

describe('Stock Movements', () => {
  it('transfers stock from backroom to shelf', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 10, shelfQty: 0 });

    const res = await request()
      .post(`/api/stores/${store.id}/movements`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, type: 'transfer_to_shelf', quantity: 4 });

    expect(res.status).toBe(201);
    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    const p = list.body.find((x) => x.id === product.id);
    expect(p.backroom_qty).toBe(6);
    expect(p.shelf_qty).toBe(4);
  });

  it('rejects a transfer larger than available backroom stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 2, shelfQty: 0 });

    const res = await request()
      .post(`/api/stores/${store.id}/movements`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, type: 'transfer_to_shelf', quantity: 5 });

    expect(res.status).toBe(400);
  });

  it('rejects an unknown movement type', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/movements`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, type: 'teleport', quantity: 1 });

    expect(res.status).toBe(400);
  });

  it('records a sale, decreasing shelf stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });

    const res = await request()
      .post(`/api/stores/${store.id}/movements`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, type: 'sale', quantity: 3 });

    expect(res.status).toBe(201);
    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).shelf_qty).toBe(7);
  });
});

describe('Shelf Audits', () => {
  it('records a matching count as confirmed (no conflict)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const { token } = await createAuditStockTaker(store.id);
    const product = await createProduct(store.id, { shelfQty: 5 });

    const res = await request()
      .post(`/api/stores/${store.id}/audits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 5, area: 'shelf' });

    expect(res.status).toBe(201);
    expect(res.body.discrepancy).toBe(0);
    expect(res.body.flaggedForRecount).toBe(false);
  });

  it('flags a conflict when two different stocktakers disagree at the same location', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const { token } = await createAuditStockTaker(store.id);
    const staff2 = await createUser(store.id, { role: 'stock_taker' });
    const product = await createProduct(store.id, { shelfQty: 5 });

    const first = await request()
      .post(`/api/stores/${store.id}/audits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 5, area: 'shelf', shelfNumber: 'S1' });
    expect(first.body.flaggedForRecount).toBe(false);

    const second = await request()
      .post(`/api/stores/${store.id}/audits`)
      .set('Authorization', `Bearer ${tokenFor(staff2)}`)
      .send({ productId: product.id, countedQty: 9, area: 'shelf', shelfNumber: 'S1' });

    expect(second.status).toBe(201);
    expect(second.body.flaggedForRecount).toBe(true);

    const conflicts = await request()
      .get(`/api/stores/${store.id}/audits/conflicts`)
      .set('Authorization', `Bearer ${token}`);
    expect(conflicts.body.length).toBeGreaterThan(0);
  });

  it('the submitter of the latest count cannot accept their own recount', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const { token } = await createAuditStockTaker(store.id);
    const staff2 = await createUser(store.id, { role: 'stock_taker' });
    const product = await createProduct(store.id, { shelfQty: 5 });

    await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 5, area: 'shelf', shelfNumber: 'S2' });
    const second = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${tokenFor(staff2)}`)
      .send({ productId: product.id, countedQty: 8, area: 'shelf', shelfNumber: 'S2' });

    const groupId = second.body.conflict_group_id;
    const res = await request()
      .post(`/api/stores/${store.id}/audits/conflicts/${groupId}/accept`)
      .set('Authorization', `Bearer ${tokenFor(staff2)}`);

    expect(res.status).toBe(400);
  });
});

describe('Shelf audits are for requested auditors only', () => {
  it('store roles cannot record or read shelf audits, even with an audit job running', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createAuditStockTaker(store.id);
    const product = await createProduct(store.id, { shelfQty: 5 });
    for (const role of ['admin', 'manager', 'staff', 'store_manager', 'shelf_manager']) {
      const u = role === 'admin' ? null : await createUser(store.id, { role });
      const T = `Bearer ${u ? tokenFor(u) : token}`;
      expect([role, (await request().post(`/api/stores/${store.id}/audits`).set('Authorization', T).send({ productId: product.id, countedQty: 5, area: 'shelf' })).status]).toEqual([role, 403]);
      expect([role, (await request().get(`/api/stores/${store.id}/audits`).set('Authorization', T)).status]).toEqual([role, 403]);
      expect([role, (await request().get(`/api/stores/${store.id}/audits/report`).set('Authorization', T)).status]).toEqual([role, 403]);
    }
  });
});


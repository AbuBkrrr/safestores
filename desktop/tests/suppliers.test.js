const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../server/db');

describe('Suppliers: CRUD', () => {
  it('creates and lists a supplier', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const create = await request()
      .post(`/api/stores/${store.id}/suppliers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Acme Ltd', contactName: 'Joe', phone: '0800', email: 'joe@acme.com' });
    expect(create.status).toBe(201);

    const list = await request().get(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Acme Ltd');
    expect(list.body[0]).toHaveProperty('total_orders', 0);
  });

  it('rejects a duplicate supplier name in the same store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Acme Ltd' });

    const res = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Acme Ltd' });
    expect(res.status).toBe(409);
  });

  it('updates a supplier', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Old Name' });

    const res = await request()
      .patch(`/api/stores/${store.id}/suppliers/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name', phone: '0900' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.phone).toBe('0900');
  });

  it('deletes a supplier without touching its purchase order history', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const created = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Acme' });
    const po = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 5 }] });

    const del = await request().delete(`/api/stores/${store.id}/suppliers/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const row = require('../server/db').prepare('SELECT supplier, supplier_id FROM purchase_orders WHERE id = ?').get(po.body.id);
    expect(row.supplier).toBe('Acme'); // free-text name preserved
    expect(row.supplier_id).toBeNull(); // normalized link cleared (ON DELETE SET NULL)
  });

  it('404s for a supplier in a different store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${other.store.id}/suppliers`).set('Authorization', `Bearer ${other.token}`).send({ name: 'Theirs' });

    const res = await request().patch(`/api/stores/${store.id}/suppliers/${created.body.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'Hijack' });
    expect(res.status).toBe(404);
  });
});

describe('Suppliers: performance & pricing alerts', () => {
  // NOTE: purchase order line items always take unit_cost from the
  // product's CURRENT cost_price at the time the PO is created (see
  // replenishmentController.createPurchaseOrder) — any unitCost passed in
  // the request body is ignored. To record two different prices for the
  // same product, the product's cost_price must actually change between
  // the two orders.
  async function receivePO(store, token, supplierName, productId, quantity) {
    const created = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: supplierName, items: [{ productId, quantity }] });
    await request().post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${token}`).send({});
    return created.body;
  }

  it('computes on-time rate and total spend for a supplier', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5 });
    const supplier = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Acme' });

    await receivePO(store, token, 'Acme', product.id, 10);

    const res = await request()
      .get(`/api/stores/${store.id}/suppliers/${supplier.body.id}/performance`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.receivedOrders).toBe(1);
    expect(res.body.totalSpend).toBe(50);
  });

  it('flags a store-wide pricing alert when two suppliers price the same product differently', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 4 });
    await receivePO(store, token, 'Cheap Co', product.id, 10); // records unit_cost=4

    await request().put(`/api/stores/${store.id}/products/${product.id}`).set('Authorization', `Bearer ${token}`).send({ costPrice: 8 });
    await receivePO(store, token, 'Pricey Co', product.id, 10); // records unit_cost=8

    const res = await request().get(`/api/stores/${store.id}/suppliers/pricing-alerts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].cheapestSupplierName).toBe('Cheap Co');
    expect(res.body[0].savingsPct).toBe(50);
  });
});

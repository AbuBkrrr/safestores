const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');

describe('Analytics', () => {
  it('summary reflects product count, stock value, and low-stock count', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { costPrice: 10, backroomQty: 5, shelfQty: 0, reorderLevel: 20 }); // low stock
    await createProduct(store.id, { costPrice: 20, backroomQty: 0, shelfQty: 100, reorderLevel: 5 }); // well stocked

    const res = await request().get(`/api/stores/${store.id}/analytics/summary`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalProducts).toBe(2);
    expect(res.body.totalStockValue).toBe(5 * 10 + 100 * 20);
    expect(res.body.lowStockCount).toBe(1);
  });

  it('stockByCategory groups value by category, defaulting to Uncategorized', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { costPrice: 10, backroomQty: 10 });

    const res = await request().get(`/api/stores/${store.id}/analytics/stock-by-category`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].category).toBe('Uncategorized');
  });

  it('reorderAlerts lists only products at/under reorder level with a suggested qty', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const low = await createProduct(store.id, { backroomQty: 1, shelfQty: 0, reorderLevel: 10 });
    await createProduct(store.id, { backroomQty: 100, shelfQty: 0, reorderLevel: 5 });

    const res = await request().get(`/api/stores/${store.id}/analytics/reorder-alerts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(low.id);
    expect(Number(res.body[0].suggested_reorder_qty)).toBeGreaterThan(0);
  });

  it('expiringSoon respects the days window and clamps to [1,90]', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0 });
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 10, expiryDate: soon });

    const res = await request().get(`/api/stores/${store.id}/analytics/expiring-soon?days=10`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.product_id === product.id)).toBe(true);
  });

  it('tenant isolation: cannot read another store\'s analytics', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();

    const res = await request()
      .get(`/api/stores/${other.store.id}/analytics/summary`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('Shrinkage Report', () => {
  it('reports value lost from a shelf audit that found LESS than expected', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5, shelfQty: 10, backroomQty: 0 });

    await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 7, area: 'shelf' }); // 3 missing

    const res = await request().get(`/api/stores/${store.id}/analytics/shrinkage`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalUnitsLost).toBe(3);
    expect(res.body.totalValueLost).toBe(15); // 3 units * ₦5 cost
    expect(res.body.byProduct[0].product_id).toBe(product.id);
  });

  it('does NOT count a count that found MORE than expected as shrinkage', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5, shelfQty: 10, backroomQty: 0 });

    await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 12, area: 'shelf' }); // found extra, not missing

    const res = await request().get(`/api/stores/${store.id}/analytics/shrinkage`).set('Authorization', `Bearer ${token}`);
    expect(res.body.totalUnitsLost).toBe(0);
    expect(res.body.byProduct).toHaveLength(0);
  });

  it('combines shelf audits and cycle counts into one report', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 2, shelfQty: 10, backroomQty: 10 });

    await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 8, area: 'shelf' }); // shelf: 10 expected, 8 found -> -2
    await request().post(`/api/stores/${store.id}/cycle-counts`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 18 }); // total on-hand 20 expected, 18 found -> -2

    const res = await request().get(`/api/stores/${store.id}/analytics/shrinkage`).set('Authorization', `Bearer ${token}`);
    expect(Number(res.body.byProduct[0].incident_count)).toBe(2);
    expect(res.body.totalUnitsLost).toBe(4);
  });

  it('a staff member cannot view the shrinkage report (admin/manager only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });
    const res = await request().get(`/api/stores/${store.id}/analytics/shrinkage`).set('Authorization', `Bearer ${tokenFor(staff)}`);
    expect(res.status).toBe(403);
  });
});

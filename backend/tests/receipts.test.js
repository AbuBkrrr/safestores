const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

// NOTE: uploadReceipt runs real OCR via Tesseract.js, which downloads its
// trained-data model from Tesseract's CDN on first use — a network call
// this sandbox can't make (only npm/apt registries are reachable), and
// something a fast/deterministic test suite shouldn't depend on regardless.
// So the OCR-parsing step itself is out of scope here; applyReceipt/
// rejectReceipt — where the actual stock-affecting business logic lives —
// are tested directly against a receipt row seeded with known parsed_items,
// bypassing the upload+OCR step entirely. uploadReceipt's own validation
// (rejecting a request with no file) IS covered, since that path returns
// before OCR ever runs.
async function seedReceipt(storeId, parsedItems, overrides = {}) {
  const { status = 'pending' } = overrides;
  const { rows } = await pool.query(
    `INSERT INTO receipts (store_id, raw_ocr_text, parsed_items, status) VALUES ($1, 'raw text', $2, $3) RETURNING *`,
    [storeId, JSON.stringify(parsedItems), status]
  );
  return rows[0];
}

describe('Receipts: upload validation', () => {
  it('rejects a receipt upload with no file', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post(`/api/stores/${store.id}/receipts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('Receipts: apply', () => {
  it('applies a receipt, creating a new product and putting stock straight on the shelf', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const receipt = await seedReceipt(store.id, [{ name: 'New Item From Receipt', quantity: 6, price: 3.5 }]);

    const res = await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/apply`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);

    const products = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    const created = products.body.find((p) => p.name === 'New Item From Receipt');
    expect(created).toBeTruthy();
    expect(created.shelf_qty).toBe(6);
    expect(created.backroom_qty).toBe(0);
  });

  it('matches an existing product by name (case-insensitive) instead of duplicating it', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const existing = await createProduct(store.id, { name: 'Milk 1L', backroomQty: 0, shelfQty: 0 });
    const receipt = await seedReceipt(store.id, [{ name: 'milk 1l', quantity: 4 }]);

    await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/apply`).set('Authorization', `Bearer ${token}`).send({});

    const products = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(products.body.filter((p) => p.id === existing.id || p.name.toLowerCase() === 'milk 1l')).toHaveLength(1);
    expect(products.body.find((p) => p.id === existing.id).shelf_qty).toBe(4);
  });

  it('cannot re-apply an already-applied receipt', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const receipt = await seedReceipt(store.id, [{ name: 'X', quantity: 1 }]);
    await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/apply`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/apply`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
  });

  it('lists receipts for the store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await seedReceipt(store.id, []);
    const res = await request().get(`/api/stores/${store.id}/receipts`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('Receipts: reject', () => {
  it('rejects a pending receipt', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const receipt = await seedReceipt(store.id, []);

    const res = await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/reject`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  it('cannot reject an already-applied receipt', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const receipt = await seedReceipt(store.id, [], { status: 'applied' });

    const res = await request().post(`/api/stores/${store.id}/receipts/${receipt.id}/reject`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

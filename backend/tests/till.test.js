// Till upgrades: store settings, tax, discounts (+ approval), split
// payments + change, parked sales, refunds/returns, shifts + Z-report,
// daily report, digital receipts.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const pricing = require('../src/utils/pricing');

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function orderWith(store, token, product, qty = 2) {
  const o = await request().post(`/api/stores/${store.id}/orders`).set(A(token)).send({});
  await request().post(`/api/stores/${store.id}/orders/${o.body.id}/items`).set(A(token)).send({ productId: product.id, quantity: qty });
  return (await request().get(`/api/stores/${store.id}/orders/${o.body.id}`).set(A(token))).body;
}

describe('pricing maths', () => {
  it('inclusive vs exclusive tax, with discounts', () => {
    expect(pricing.computeTotals({ subtotal: 100, taxRatePct: 7.5, taxInclusive: true })).toEqual({ subtotal: 100, discountAmount: 0, taxAmount: 6.98, total: 100 });
    expect(pricing.computeTotals({ subtotal: 100, taxRatePct: 7.5, taxInclusive: false })).toEqual({ subtotal: 100, discountAmount: 0, taxAmount: 7.5, total: 107.5 });
    expect(pricing.computeTotals({ subtotal: 100, discountType: 'percent', discountValue: 10, taxRatePct: 0 }).total).toBe(90);
    expect(pricing.computeTotals({ subtotal: 50, discountType: 'amount', discountValue: 80 }).total).toBe(0);
  });
  it('allocates split tenders; only cash produces change', () => {
    const a = pricing.allocatePayments(26, [{ method: 'card', amount: 10 }, { method: 'cash', amount: 20 }]);
    expect(a.ok).toBe(true);
    expect(a.change).toBe(4);
    expect(a.applied).toEqual([{ method: 'card', amount: 10 }, { method: 'cash', amount: 16 }]);
    expect(pricing.allocatePayments(26, [{ method: 'card', amount: 30 }]).ok).toBe(false);
    expect(pricing.allocatePayments(26, [{ method: 'cash', amount: 20 }]).ok).toBe(false);
  });
});

describe('Store settings', () => {
  it('admin sets currency/time zone/tax; everyone can read; cashiers cannot write', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const bad = await request().patch(`/api/stores/${store.id}/settings`).set(A(token)).send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    const res = await request().patch(`/api/stores/${store.id}/settings`).set(A(token)).send({ currencyCode: 'kes', timezone: 'Africa/Nairobi', taxRatePct: 16, taxInclusive: true, receiptFooter: 'Asante!' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currency_code: 'KES', timezone: 'Africa/Nairobi', tax_rate_pct: 16, receipt_footer: 'Asante!' });
    expect(res.body.currency_symbol).toBeTruthy();

    const pub = await request().get('/api/settings/currency').query({ storeId: store.id });
    expect(pub.body.code).toBe('KES');

    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().get(`/api/stores/${store.id}/settings`).set(A(tokenFor(cashier)))).status).toBe(200);
    expect((await request().patch(`/api/stores/${store.id}/settings`).set(A(tokenFor(cashier))).send({ taxRatePct: 0 })).status).toBe(403);
  });
});

describe('Tax, discounts and payments at the till', () => {
  it('applies exclusive tax to new orders and takes a split payment with change', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().patch(`/api/stores/${store.id}/settings`).set(A(token)).send({ taxRatePct: 10, taxInclusive: false });
    const product = await createProduct(store.id, { shelfQty: 10 }); // price 13
    const order = await orderWith(store, token, product, 2); // 26 + 10% = 28.6
    expect(Number(order.total)).toBe(28.6);
    expect(Number(order.tax_amount)).toBe(2.6);

    const pay = await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token))
      .send({ payments: [{ method: 'card', amount: 10, reference: 'POS-1' }, { method: 'cash', amount: 20 }] });
    expect(pay.status).toBe(200);
    expect(pay.body.payment_method).toBe('split');
    expect(Number(pay.body.change_due)).toBe(1.4);
    const full = await request().get(`/api/stores/${store.id}/orders/${order.id}`).set(A(token));
    expect(full.body.payments.map((p) => [p.method, Number(p.amount)])).toEqual([['card', 10], ['cash', 18.6]]);
    expect(full.body.store.name).toBe(store.name);
    expect(full.body.public_token).toBeTruthy();

    const pub = await request().get(`/api/public/receipts/${full.body.public_token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.items[0].quantity).toBe(2);
    expect(pub.body.store.name).toBe(store.name);
  });

  it('rejects short payments', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 1);
    const res = await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token)).send({ payments: [{ method: 'cash', amount: 5 }] });
    expect(res.status).toBe(400);
  });

  it('cashier discount within the limit is fine; above it needs manager credentials', async () => {
    const { store, token, admin } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    const ct = tokenFor(cashier);
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, ct, product, 2); // 26

    const ok = await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(ct)).send({ type: 'percent', value: 10, reason: 'Loyal customer' });
    expect(ok.status).toBe(200);
    expect(Number(ok.body.total)).toBe(23.4);

    const big = await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(ct)).send({ type: 'amount', value: 13 });
    expect(big.status).toBe(403);
    expect(big.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');

    const wrong = await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(ct)).send({ type: 'amount', value: 13, approverEmail: admin.email, approverPassword: 'nope' });
    expect(wrong.status).toBe(403);

    const approved = await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(ct)).send({ type: 'amount', value: 13, approverEmail: admin.email, approverPassword: admin.plainPassword });
    expect(approved.status).toBe(200);
    expect(Number(approved.body.total)).toBe(13);
    expect(approved.body.discount_approved_by).toBe(admin.id);

    const cleared = await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(ct)).send({ type: null });
    expect(Number(cleared.body.total)).toBe(26);
  });

  it('parks a sale with a label', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 1);
    const res = await request().patch(`/api/stores/${store.id}/orders/${order.id}/park`).set(A(token)).send({ label: 'Lady in red' });
    expect(res.body.parked_label).toBe('Lady in red');
    const list = await request().get(`/api/stores/${store.id}/orders`).query({ status: 'pending_payment' }).set(A(token));
    expect(list.body[0].parked_label).toBe('Lady in red');
  });

  it('a credit portion of a split payment is posted to the customer ledger', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const cust = await request().post(`/api/stores/${store.id}/customers`).set(A(token)).send({ name: 'Mama Ngozi' });
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 2); // 26
    const pay = await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token))
      .send({ payments: [{ method: 'cash', amount: 6 }, { method: 'credit', amount: 20 }], storeCustomerId: cust.body.id });
    expect(pay.status).toBe(200);
    const { rows } = await pool.query('SELECT type, amount FROM customer_ledger_entries WHERE store_customer_id = $1', [cust.body.id]);
    expect(rows.map((r) => [r.type, Number(r.amount)])).toEqual([['credit_sale', 20]]);
  });
});

describe('Refunds and returns', () => {
  it('partial refund restocks, adjusts sold qty, and blocks over-refunding', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 3); // 39
    await request().post(`/api/stores/${store.id}/orders/${order.id}/discount`).set(A(token)).send({ type: 'amount', value: 9 }); // total 30
    await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });
    const item = order.items[0];

    const r1 = await request().post(`/api/stores/${store.id}/orders/${order.id}/refunds`).set(A(token))
      .send({ items: [{ orderItemId: item.id, quantity: 1, restock: true }], method: 'cash', reason: 'Wrong size' });
    expect(r1.status).toBe(201);
    expect(r1.body.refund.amount).toBe(10); // 13 × (30/39)
    let p = (await pool.query('SELECT shelf_qty, sold_qty, damaged_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect([p.shelf_qty, p.sold_qty]).toEqual([8, 2]);

    const r2 = await request().post(`/api/stores/${store.id}/orders/${order.id}/refunds`).set(A(token))
      .send({ items: [{ orderItemId: item.id, quantity: 1, restock: false }], method: 'cash' });
    expect(r2.status).toBe(201);
    p = (await pool.query('SELECT shelf_qty, sold_qty, damaged_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect([p.shelf_qty, p.sold_qty, p.damaged_qty]).toEqual([8, 1, 1]);

    const over = await request().post(`/api/stores/${store.id}/orders/${order.id}/refunds`).set(A(token))
      .send({ items: [{ orderItemId: item.id, quantity: 2 }], method: 'cash' });
    expect(over.status).toBe(400);

    const full = await request().get(`/api/stores/${store.id}/orders/${order.id}`).set(A(token));
    expect(Number(full.body.refunded_total)).toBe(20);
    expect(full.body.items[0].refunded_qty).toBe(2);
  });

  it('cashiers cannot refund; unpaid orders cannot be refunded', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 1);
    expect((await request().post(`/api/stores/${store.id}/orders/${order.id}/refunds`).set(A(token)).send({ items: [{ orderItemId: order.items[0].id, quantity: 1 }] })).status).toBe(400);
    await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });
    expect((await request().post(`/api/stores/${store.id}/orders/${order.id}/refunds`).set(A(tokenFor(cashier))).send({ items: [{ orderItemId: order.items[0].id, quantity: 1 }] })).status).toBe(403);
  });

  it('cancelling an unpaid order no longer inflates sold quantity', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 2);
    await request().post(`/api/stores/${store.id}/orders/${order.id}/cancel`).set(A(token));
    const p = (await pool.query('SELECT shelf_qty, sold_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect([p.shelf_qty, p.sold_qty]).toEqual([10, 0]);
  });
});

describe('Shifts and reports', () => {
  it('open → sell → refund → close gives the right expected cash and Z-report', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().patch(`/api/stores/${store.id}/settings`).set(A(token)).send({ requireShift: true });
    const product = await createProduct(store.id, { shelfQty: 10 });

    const o1 = await orderWith(store, token, product, 2); // 26
    const blocked = await request().post(`/api/stores/${store.id}/orders/${o1.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });
    expect(blocked.body.code).toBe('SHIFT_REQUIRED');

    const shift = await request().post(`/api/stores/${store.id}/shifts`).set(A(token)).send({ openingFloat: 50 });
    expect(shift.status).toBe(201);
    expect((await request().post(`/api/stores/${store.id}/shifts`).set(A(token)).send({ openingFloat: 50 })).body.id).toBe(shift.body.id);

    await request().post(`/api/stores/${store.id}/orders/${o1.id}/pay`).set(A(token)).send({ payments: [{ method: 'cash', amount: 30 }] }); // cash 26, change 4
    const o2 = await orderWith(store, token, product, 1); // 13
    await request().post(`/api/stores/${store.id}/orders/${o2.id}/pay`).set(A(token)).send({ payments: [{ method: 'card', amount: 13 }] });
    await request().post(`/api/stores/${store.id}/orders/${o1.id}/refunds`).set(A(token)).send({ items: [{ orderItemId: o1.items[0].id, quantity: 1 }], method: 'cash' }); // -13 cash

    const cur = await request().get(`/api/stores/${store.id}/shifts/current`).set(A(token));
    expect(Number(cur.body.expected_cash_now)).toBe(63); // 50 + 26 − 13

    const closed = await request().post(`/api/stores/${store.id}/shifts/${shift.body.id}/close`).set(A(token)).send({ countedCash: 60, notes: 'Short 3' });
    expect(closed.status).toBe(200);
    expect(closed.body.variance).toBe(-3);

    const z = await request().get(`/api/stores/${store.id}/shifts/${shift.body.id}/report`).set(A(token));
    expect(z.body.sales).toMatchObject({ count: 2, gross: 39, units: 3 });
    expect(z.body.refunds.total).toBe(13);
    expect(z.body.net).toBe(26);
    expect(z.body.cash).toMatchObject({ openingFloat: 50, cashSales: 26, cashRefunds: 13, expected: 63, counted: 60, variance: -3 });
    expect(z.body.payments.find((p) => p.method === 'card').total).toBe(13);

    const daily = await request().get(`/api/stores/${store.id}/reports/daily`).set(A(token));
    expect(daily.status).toBe(200);
    expect(daily.body.orders).toBe(2);
    expect(daily.body.gross).toBe(39);
    expect(daily.body.refunds.total).toBe(13);
    expect(daily.body.topItems[0].units).toBe(3);
  });

  it('finds a sale by receipt number', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const order = await orderWith(store, token, product, 1);
    const paid = await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });
    const tail = paid.body.receipt_number.slice(-4).toLowerCase();
    const res = await request().get(`/api/stores/${store.id}/orders`).query({ q: tail, status: 'paid' }).set(A(token));
    expect(res.body.map((o) => o.id)).toContain(order.id);
  });
});

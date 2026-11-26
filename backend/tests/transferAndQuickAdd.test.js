const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor } = require('./helpers/factories');

describe('Bank transfer on the storefront', () => {
  it('store saves its account; shopper pays by transfer and sees the details', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    let r = await request().patch(`/api/stores/${store.id}/payouts`).set(auth).send({ transferEnabled: true, transfer: { bankName: 'Opay' } });
    expect(r.status).toBe(400); // account number + name needed
    r = await request().patch(`/api/stores/${store.id}/payouts`).set(auth)
      .send({ transferEnabled: true, transfer: { bankName: 'Opay', accountNumber: '8012345678', accountName: 'I&I General Ent', note: 'Send proof on WhatsApp' } });
    expect(r.status).toBe(200);
    expect(r.body.transfer_enabled).toBe(true);

    const prod = await request().post(`/api/stores/${store.id}/products`).set(auth)
      .send({ name: 'Rim paper', sku: `RIM-${Date.now()}`, costPrice: 1000, priceMultiplier: 1.5, initialBackroomQty: 10, putOnShelf: 10 });
    expect(prod.status).toBe(201);
    expect(Number(prod.body.shelf_qty)).toBe(10); // on the shelf at once
    expect(Number(prod.body.backroom_qty)).toBe(0);

    const info = await request().get(`/api/public/stores/${store.id}`);
    expect(info.body.payments.transfer).toMatchObject({ bankName: 'Opay', accountNumber: '8012345678' });

    const order = await request().post(`/api/marketplace/${store.id}/orders`)
      .send({ items: [{ productId: prod.body.id, quantity: 2 }], guestName: 'Ada', guestPhone: '0803', paymentMethod: 'transfer', fulfilmentMethod: 'pickup' });
    expect(order.status).toBe(201);
    expect(order.body.payment_method).toBe('transfer');
    expect(order.body.transfer.accountName).toBe('I&I General Ent');
    const track = await request().get(`/api/public/marketplace-orders/${order.body.tracking_token}`);
    expect(track.body.transfer.accountNumber).toBe('8012345678');

    // Shopper taps "I've sent the payment": the shop is told (socket + push).
    const realtime = require('../src/realtime');
    const emit = jest.spyOn(realtime, 'emitToStore');
    const sent = await request().post(`/api/public/marketplace-orders/${order.body.tracking_token}/payment-sent`);
    expect(sent.status).toBe(200);
    expect(sent.body.transfer_sent_at).toBeTruthy();
    expect(emit).toHaveBeenCalledWith(store.id, 'marketplace:payment_sent', expect.objectContaining({ id: order.body.id }));
    emit.mockRestore();
    expect((await request().get(`/api/public/marketplace-orders/${order.body.tracking_token}`)).body.transfer_sent_at).toBeTruthy();
    expect((await request().post('/api/public/marketplace-orders/not-a-real-token/payment-sent')).status).toBe(404);

    // The shop sees the money in its bank and confirms.
    const got = await request().patch(`/api/stores/${store.id}/marketplace/orders/${order.body.id}/transfer-received`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body.payment_status).toBe('paid');
    expect((await request().get(`/api/public/marketplace-orders/${order.body.tracking_token}`)).body.payment_status).toBe('paid');
    // A cashier can't mark money received.
    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().patch(`/api/stores/${store.id}/marketplace/orders/${order.body.id}/transfer-received`).set('Authorization', `Bearer ${tokenFor(cashier)}`)).status).toBe(403);
  });

  it('a store manager can add products', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const sm = await createUser(store.id, { role: 'store_manager' });
    const r = await request().post(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${tokenFor(sm)}`)
      .send({ name: 'Biro', sku: `BIRO-${Date.now()}`, costPrice: 50, priceMultiplier: 2 });
    expect(r.status).toBe(201);
  });
});

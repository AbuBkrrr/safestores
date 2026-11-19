// Repair shops: a customer's car or device is checked in, QR-tagged, worked on
// with notes and parts from stock, and handed back only against its own tag.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

async function repairShop(type) {
  const { store, token } = await createActiveStoreWithAdmin();
  const A = { Authorization: `Bearer ${token}` };
  await request().patch(`/api/stores/${store.id}/settings`).set(A).send({ businessType: type });
  const call = (m, p, b) => request()[m](`/api/stores/${store.id}${p}`).set(A).send(b);
  return { store, call };
}

describe('Repair jobs with QR-tagged items', () => {
  it('phone repair: check-in with device details, tag scan, diagnosis, notes, parts, and collection only with the right tag', async () => {
    const { store, call } = await repairShop('tech_repair');
    expect((await call('get', '/settings')).body.tools).toEqual(expect.arrayContaining(['jobs', 'repair']));
    const screen = await createProduct(store.id, { name: 'iPhone 11 screen', costPrice: 25000, backroomQty: 3 });

    const job = await call('post', '/jobs', {
      customerName: 'Chidi Eze', customerPhone: '08031112222', title: 'Cracked screen, phone won\'t charge',
      items: [{ description: 'Screen replacement', quantity: 1, price: 45000 }, { description: 'Labour', quantity: 1, price: 5000 }],
      deposit: 20000, method: 'transfer',
      itemDetails: { kind: 'Phone', make: 'Apple', model: 'iPhone 11', serial: '356789101112131', colour: 'Black', password: 'never stored' },
      fault: 'Screen cracked after a fall; not charging', condition: 'Back glass scratched', accessories: 'Case, no charger',
    });
    expect(job.status).toBe(201);
    expect(job.body.tag_code).toMatch(/^T[A-Z2-9]{6}$/);
    expect(job.body.item_details).toEqual({ kind: 'Phone', make: 'Apple', model: 'iPhone 11', serial: '356789101112131', colour: 'Black' });
    expect(job.body).toMatchObject({ fault: 'Screen cracked after a fall; not charging', condition_notes: 'Back glass scratched', accessories: 'Case, no charger' });

    // Scanning the tag (as a link, or typed) opens the job.
    const tag = job.body.tag_code;
    expect((await call('get', `/jobs/tag/${encodeURIComponent(`https://app.example/jobs?tag=${tag}`)}`)).body.id).toBe(job.body.id);
    expect((await call('get', `/jobs/tag/${tag.toLowerCase()}`)).body.id).toBe(job.body.id);
    expect((await call('get', '/jobs/tag/TZZZZZZ')).status).toBe(404);

    await call('patch', `/jobs/${job.body.id}/status`, { status: 'diagnosing' });
    const d = await call('patch', `/jobs/${job.body.id}/repair`, { diagnosis: 'Screen and charging port damaged' });
    expect(d.body.diagnosis).toBe('Screen and charging port damaged');
    const n = await call('post', `/jobs/${job.body.id}/notes`, { note: 'Customer approved the quote by phone' });
    expect(n.body.notes_log).toEqual([expect.objectContaining({ note: 'Customer approved the quote by phone' })]);
    await call('patch', `/jobs/${job.body.id}/status`, { status: 'waiting_parts' });
    expect((await call('post', `/jobs/${job.body.id}/materials`, { productId: screen.id, quantity: 1 })).status).toBe(201);
    await call('patch', `/jobs/${job.body.id}/status`, { status: 'ready' });

    // Searching by serial/IMEI finds it.
    expect((await call('get', '/jobs?q=35678910')).body.map((j) => j.id)).toContain(job.body.id);

    // A second customer's item, then a hand-back with the wrong tag is refused.
    const other = await call('post', '/jobs', { customerName: 'Ada', title: 'Laptop fan', items: [{ description: 'Fan', quantity: 1, price: 8000 }] });
    const wrong = await call('post', `/jobs/${job.body.id}/collect`, { method: 'cash', tagCode: other.body.tag_code });
    expect(wrong.body.code).toBe('WRONG_ITEM');
    const ok = await call('post', `/jobs/${job.body.id}/collect`, { method: 'cash', tagCode: tag });
    expect(ok.body).toMatchObject({ status: 'collected', balancePaid: 30000 });
    expect((await pool.query('SELECT backroom_qty FROM products WHERE id = $1', [screen.id])).rows[0].backroom_qty).toBe(2);
  });

  it('mechanic: finds a car by its plate number; shops that are not repair shops get no tags', async () => {
    const { call } = await repairShop('mechanic');
    const job = await call('post', '/jobs', {
      customerName: 'Musa Bello', title: 'Brakes squeal', items: [{ description: 'Brake pads', quantity: 1, price: 18000 }],
      itemDetails: { kind: 'Car', make: 'Toyota', model: 'Corolla 2012', plate: 'KJA-123-AB', mileage: '184000' },
    });
    expect((await call('get', '/jobs?q=kja-123')).body[0]).toMatchObject({ id: job.body.id, tag_code: job.body.tag_code });

    const tailor = await repairShop('tailor');
    const t = await tailor.call('post', '/jobs', { customerName: 'Ngozi', title: 'Agbada', items: [{ description: 'Sewing', quantity: 1, price: 15000 }] });
    expect(t.body.tag_code).toBeNull();
  });
});

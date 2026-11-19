const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const { networkKey, checkOnsite, distanceMetres } = require('../src/utils/onsite');

// The app trusts one proxy hop, so X-Forwarded-For stands in for "which
// internet connection this phone is on".
const SHOP_IP = '198.51.100.7';
const HOME_IP = '203.0.113.9';
const SHOP = { lat: 6.5244, lng: 3.3792 }; // Lagos

async function setup() {
  const { store, token: adminToken } = await createActiveStoreWithAdmin();
  const cashier = await createUser(store.id, { role: 'cashier', name: 'Ada Cashier' });
  const base = `/api/stores/${store.id}`;
  const as = (token, ip) => ({
    post: (p, body) => request().post(base + p).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip).send(body),
    get: (p) => request().get(base + p).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip),
    patch: (p, body) => request().patch(base + p).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip).send(body),
    del: (p) => request().delete(base + p).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip),
  });
  return { store, owner: (ip = SHOP_IP) => as(adminToken, ip), cashier: (ip) => as(tokenFor(cashier), ip) };
}

describe('In-store only: rules', () => {
  it('compares IPv4 exactly and IPv6 by its /64 network', () => {
    expect(networkKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(networkKey('2001:db8:abcd:12::1')).toBe(networkKey('2001:0db8:abcd:0012:ffff:1:2:3'));
    expect(networkKey('2001:db8:abcd:12::1')).not.toBe(networkKey('2001:db8:abcd:13::1'));
  });

  it('passes on a saved connection, or a GPS fix inside the radius; refuses vague or distant fixes', () => {
    const store = { onsite_networks: [{ ip: SHOP_IP }], onsite_lat: SHOP.lat, onsite_lng: SHOP.lng, onsite_radius_m: 100 };
    expect(checkOnsite(store, { ip: SHOP_IP })).toMatchObject({ ok: true, how: 'network' });
    expect(checkOnsite(store, { ip: HOME_IP })).toMatchObject({ ok: false, how: 'location_needed' });
    expect(checkOnsite(store, { ip: HOME_IP, lat: SHOP.lat + 0.0005, lng: SHOP.lng, accuracy: 20 })).toMatchObject({ ok: true, how: 'gps' });
    expect(checkOnsite(store, { ip: HOME_IP, lat: SHOP.lat, lng: SHOP.lng, accuracy: 900 })).toMatchObject({ ok: false, how: 'location_too_vague' });
    const far = checkOnsite(store, { ip: HOME_IP, lat: SHOP.lat + 0.05, lng: SHOP.lng, accuracy: 10 });
    expect(far).toMatchObject({ ok: false, how: 'outside_radius' });
    expect(far.distance).toBeGreaterThan(5000);
    expect(Math.round(distanceMetres(0, 0, 0.001, 0))).toBe(111);
  });
});

describe('In-store only: the lock', () => {
  it('is off by default: a cashier can sell from anywhere', async () => {
    const { cashier } = await setup();
    const res = await cashier(HOME_IP).post('/orders', {});
    expect(res.status).toBe(201);
  });

  it('cannot be switched on before the shop connection or location is set', async () => {
    const { owner } = await setup();
    const res = await owner().patch('/onsite', { enabled: true });
    expect(res.status).toBe(400);
  });

  it('only the owner manages it', async () => {
    const { cashier } = await setup();
    expect((await cashier(SHOP_IP).get('/onsite')).status).toBe(403);
    expect((await cashier(SHOP_IP).post('/onsite/networks', {})).status).toBe(403);
  });

  it('blocks a cashier off the shop connection, lets them in on it, and alerts the owner once', async () => {
    const { store, owner, cashier } = await setup();
    const saved = await owner(SHOP_IP).post('/onsite/networks', { label: 'Shop Wi-Fi' });
    expect(saved.status).toBe(201);
    expect(saved.body.networks).toEqual([expect.objectContaining({ ip: SHOP_IP, label: 'Shop Wi-Fi' })]);
    expect((await owner(SHOP_IP).post('/onsite/networks', {})).status).toBe(409);
    expect((await owner(SHOP_IP).patch('/onsite', { enabled: true })).body.enabled).toBe(true);
    expect((await owner(SHOP_IP).get('/onsite')).body.onShopNetwork).toBe(true);

    const blocked = await cashier(HOME_IP).post('/orders', {});
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'OFFSITE', reason: 'not_on_shop_network', canUseLocation: false });
    expect((await cashier(HOME_IP).post('/orders', {})).status).toBe(403);

    expect((await cashier(SHOP_IP).post('/orders', {})).status).toBe(201);
    // Looking things up is still fine away from the shop.
    expect((await cashier(HOME_IP).get('/products')).status).toBe(200);
    // The owner works from anywhere.
    expect((await owner(HOME_IP).post('/orders', {})).status).toBe(201);

    const { rows: alerts } = await pool.query(`SELECT message FROM store_notifications WHERE store_id = $1 AND type = 'offsite_attempt'`, [store.id]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/Ada Cashier \(cashier\) tried to ring up a sale from outside the shop/);
    const { rows: log } = await pool.query(`SELECT COUNT(*)::int AS n FROM activity_log WHERE store_id = $1 AND action = 'offsite_blocked'`, [store.id]);
    expect(log[0].n).toBe(2);
  });

  it('accepts phone GPS inside the shop radius when off the shop connection, and says how far away a blocked phone is', async () => {
    const { store, owner, cashier } = await setup();
    await owner().patch('/onsite', { location: SHOP, radiusM: 80, enabled: true });

    const noFix = await cashier(HOME_IP).post('/orders', {});
    expect(noFix.body).toMatchObject({ code: 'OFFSITE', reason: 'location_needed', canUseLocation: true });

    const inside = await cashier(HOME_IP).post('/orders', {}).set('X-Geo-Lat', String(SHOP.lat + 0.0003)).set('X-Geo-Lng', String(SHOP.lng)).set('X-Geo-Accuracy', '15');
    expect(inside.status).toBe(201);

    const away = await cashier(HOME_IP).post('/orders', {}).set('X-Geo-Lat', String(SHOP.lat + 0.02)).set('X-Geo-Lng', String(SHOP.lng)).set('X-Geo-Accuracy', '15');
    expect(away.status).toBe(403);
    expect(away.body.reason).toBe('outside_radius');
    const { rows } = await pool.query(`SELECT message FROM store_notifications WHERE store_id = $1 AND type = 'offsite_attempt'`, [store.id]);
    expect(rows.map((r) => r.message).join(' ')).toMatch(/km from the shop|m from the shop|from outside the shop/);
  });

  it('judges sales made with no internet by where they were made, not where they are synced from', async () => {
    const { store, owner, cashier } = await setup();
    await owner(SHOP_IP).post('/onsite/networks', {});
    await owner(SHOP_IP).patch('/onsite', { location: SHOP, radiusM: 80, enabled: true });
    const replay = (ip) => cashier(ip).post('/orders?_offlineReplay=true', {});
    const madeAt = (lat) => ({ 'X-Geo-Lat': String(lat), 'X-Geo-Lng': String(SHOP.lng), 'X-Geo-Accuracy': '15' });

    // Rung up at home in airplane mode, synced on the shop Wi-Fi: refused.
    const atHome = await replay(SHOP_IP).set(madeAt(SHOP.lat + 0.05));
    expect(atHome.status).toBe(403);
    expect(atHome.body.reason).toBe('outside_radius');
    // Made in the shop while the internet was down, synced from anywhere: accepted.
    expect((await replay(HOME_IP).set(madeAt(SHOP.lat + 0.0002))).status).toBe(201);
    // No location saved: accepted only from the shop connection, and the owner is told.
    expect((await replay(HOME_IP)).status).toBe(403);
    expect((await replay(SHOP_IP)).status).toBe(201);
    const { rows } = await pool.query(`SELECT message FROM store_notifications WHERE store_id = $1 AND type = 'offline_sync_unverified'`, [store.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toMatch(/could not confirm they were made in the shop/);
  });

  it('will not remove the last way to confirm staff while the lock is on', async () => {
    const { owner } = await setup();
    await owner().post('/onsite/networks', {});
    await owner().patch('/onsite', { enabled: true });
    expect((await owner().del('/onsite/networks/0')).status).toBe(400);
    await owner().patch('/onsite', { location: SHOP });
    expect((await owner().del('/onsite/networks/0')).status).toBe(200);
  });
});

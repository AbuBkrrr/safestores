const { request } = require('./helpers/app');
const { createSuperAdmin, superToken } = require('./helpers/factories');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_WA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0 Mobile Safari/537.36 WhatsApp/2.23';

describe('Marketing tracking', () => {
  it('tells the same device coming back from a link being shared', async () => {
    const sa = { Authorization: `Bearer ${superToken(await createSuperAdmin())}` };
    const link = (await request().post('/api/super/marketing/links').set(sa).send({ label: 'Flyer Kano', channel: 'flyer' })).body;
    expect(link.code).toBeTruthy();

    const open = (ua, deviceId, tz) => request().post('/api/m/open').set('User-Agent', ua).set('Origin', 'https://safestores.name.ng')
      .set('Content-Type', 'text/plain').send(JSON.stringify({ ref: link.code, deviceId, tz, lang: 'en-NG' }));
    const a1 = await open(IPHONE, 'aaaaaaaa-1111', 'Africa/Lagos');
    expect(a1.body).toMatchObject({ deviceNo: 1, openNo: 1, newDevice: true });
    expect(a1.headers['access-control-allow-origin']).toBe('https://safestores.name.ng');
    await open(IPHONE, 'aaaaaaaa-1111', 'Africa/Lagos');
    const a3 = await open(IPHONE, 'aaaaaaaa-1111', 'Africa/Lagos');
    expect(a3.body).toMatchObject({ deviceNo: 1, openNo: 3, newDevice: false });

    let links = (await request().get('/api/super/marketing/links').set(sa)).body;
    expect(links.find((l) => l.code === link.code)).toMatchObject({ opens: 3, devices: 1, repeat_opens: 2, verdict: '1 device, opened 3×' });

    const b1 = await open(ANDROID_WA, 'bbbbbbbb-2222', 'Africa/Nairobi');
    expect(b1.body).toMatchObject({ deviceNo: 2, openNo: 1 });
    links = (await request().get('/api/super/marketing/links').set(sa)).body;
    expect(links.find((l) => l.code === link.code)).toMatchObject({ opens: 4, devices: 2, verdict: 'Shared · 2 devices' });

    const opens = (await request().get('/api/super/marketing/opens').query({ link: link.code }).set(sa)).body;
    expect(opens[0]).toMatchObject({ device_no: 2, open_no: 1, in_app: 'WhatsApp', country: 'Kenya', model: 'SM-A145F' });
    expect(opens[1]).toMatchObject({ device_no: 1, open_no: 3, country: 'Nigeria', model: 'iPhone' });

    // Lead from device A: shows its 3 opens.
    const lead = await request().post('/api/m/lead').set('Content-Type', 'text/plain')
      .send(JSON.stringify({ ref: link.code, deviceId: 'aaaaaaaa-1111', name: 'Ada', phone: '+2348000000000', consent: true }));
    expect(lead.status).toBe(201);
    const leads = (await request().get('/api/super/marketing/leads').set(sa)).body;
    expect(leads.find((l) => l.id === lead.body.id).device_opens).toBe(3);

    // Sign-up credited to the link.
    const su = await request().post('/api/auth/store/signup').send({ storeName: 'Ada Shop', adminName: 'Ada', adminEmail: `ada${Date.now()}@ex.com`, password: 'Str0ng!Passw0rd', refCode: link.code, refDevice: 'aaaaaaaa-1111' });
    expect(su.status).toBe(201);
    links = (await request().get('/api/super/marketing/links').set(sa)).body;
    expect(links.find((l) => l.code === link.code).signups).toBe(1);
    expect((await request().get('/api/super/marketing/leads').set(sa)).body.find((l) => l.id === lead.body.id).status).toBe('registered');

    // QR redirect
    const go = await request().get(`/go/${link.code}`);
    expect(go.status).toBe(302);
    expect(go.headers.location).toContain(`ref=${link.code}`);
  });

  it('only Super Admin sees marketing', async () => {
    expect((await request().get('/api/super/marketing/links')).status).toBe(401);
  });
});

describe('Marketing link address', () => {
  it('Super Admin sets the domain; links and the QR redirect follow it', async () => {
    const sa = { Authorization: `Bearer ${superToken(await createSuperAdmin())}` };
    const bad = await request().put('/api/super/marketing/settings').set(sa).send({ linkBase: 'not a url' });
    expect(bad.status).toBe(400);
    const r = await request().put('/api/super/marketing/settings').set(sa)
      .send({ linkBase: 'https://app.safestores.com.ng/', landingUrl: 'https://safestores.com.ng' });
    expect(r.body.effective).toMatchObject({ base: 'https://app.safestores.com.ng', landing: 'https://safestores.com.ng/', signup: 'https://app.safestores.com.ng/signup' });
    const link = (await request().post('/api/super/marketing/links').set(sa).send({ label: 'Com.ng test' })).body;
    expect(link.url).toBe(`https://app.safestores.com.ng/go/${link.code}`);
    const listed = (await request().get('/api/super/marketing/links').set(sa)).body.find((l) => l.code === link.code);
    expect(listed.url).toBe(`https://app.safestores.com.ng/go/${link.code}`);
    expect((await request().get(`/go/${link.code}`)).headers.location).toBe(`https://safestores.com.ng/?ref=${link.code}`);
    await request().put('/api/super/marketing/settings').set(sa).send({}); // back to defaults
  });
});

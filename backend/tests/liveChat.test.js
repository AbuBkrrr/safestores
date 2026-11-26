const { request } = require('./helpers/app');
const { createSuperAdmin, superToken } = require('./helpers/factories');

const post = (body) => request().post('/api/m/chat').set('Content-Type', 'text/plain').send(JSON.stringify(body));

describe('Live support chat', () => {
  it('a visitor chats and Super Admin answers in Support Tickets', async () => {
    const sa = { Authorization: `Bearer ${superToken(await createSuperAdmin())}` };
    expect((await post({ name: 'Bisi' })).status).toBe(400);

    const first = await post({ name: 'Bisi', phone: '0803', message: 'How much is Mini?', page: '/market' });
    expect(first.status).toBe(201);
    const { token } = first.body;
    expect(token).toMatch(/^[a-f0-9]{48}$/);

    const tk = (await request().get('/api/super/support/tickets').set(sa)).body.find((t) => t.source === 'chat' && t.contact_name === 'Bisi');
    expect(tk).toMatchObject({ store_id: null, priority: 'high', message: 'How much is Mini?' });

    expect((await request().post(`/api/super/support/tickets/${tk.id}/reply`).set(sa).send({ message: 'Mini is free to start' })).status).toBe(201);
    expect((await post({ token, message: 'Thanks!' })).status).toBe(201);

    const chat = (await request().get(`/api/m/chat/${token}`)).body;
    expect(chat.messages.map((m) => [m.from, m.text])).toEqual([
      ['me', 'How much is Mini?'], ['support', 'Mini is free to start'], ['me', 'Thanks!']]);

    const detail = (await request().get(`/api/super/support/tickets/${tk.id}`).set(sa)).body;
    expect(detail.replies.map((r) => r.author_type)).toEqual(['super_admin', 'visitor']);

    // A resolved chat reopens when the visitor writes again.
    await request().patch(`/api/super/support/tickets/${tk.id}`).set(sa).send({ status: 'resolved' });
    await post({ token, message: 'One more question' });
    expect((await request().get(`/api/super/support/tickets/${tk.id}`).set(sa)).body.status).toBe('open');
  });

  it('a wrong or made-up chat code reads nothing', async () => {
    expect((await request().get(`/api/m/chat/${'a'.repeat(48)}`)).status).toBe(404);
    expect((await request().get('/api/m/chat/../../etc')).status).toBe(404);
    // An unknown code starts a new chat instead of writing into someone else's.
    const r = await post({ token: 'b'.repeat(48), name: 'X', message: 'hi' });
    expect(r.status).toBe(201);
    expect(r.body.token).not.toBe('b'.repeat(48));
  });
});

describe('Website ping', () => {
  it('answers any site, so the website can find the live app address', async () => {
    const r = await request().get('/api/m/ping').set('Origin', 'https://safestore.com.ng');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://safestore.com.ng');
  });
});

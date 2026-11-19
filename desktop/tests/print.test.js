const net = require('net');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const { isPrivateIPv4 } = require('../server/controllers/printController');

describe('Network (Wi-Fi) receipt printing', () => {
  it('only allows shop-network addresses', () => {
    expect(isPrivateIPv4('192.168.1.50')).toBe(true);
    expect(isPrivateIPv4('10.0.0.9')).toBe(true);
    expect(isPrivateIPv4('172.20.1.1')).toBe(true);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('127.0.0.1')).toBe(false);
    expect(isPrivateIPv4('printer.example.com')).toBe(false);
  });

  it('needs a login', async () => {
    const res = await request().post('/api/print/network').send({ host: '192.168.1.50', data: 'AA==' });
    expect(res.status).toBe(401);
  });

  it('rejects public addresses and odd ports', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request().post('/api/print/network').set(auth).send({ host: '8.8.8.8', data: 'AA==' })).status).toBe(400);
    expect((await request().post('/api/print/network').set(auth).send({ host: '192.168.1.5', port: 22, data: 'AA==' })).status).toBe(400);
    expect((await request().post('/api/print/network').set(auth).send({ host: '192.168.1.5' })).status).toBe(400);
  });

  it('delivers the exact bytes to a printer listening on port 9100', async () => {
    // Fake printer on the loopback; the address check is bypassed by pointing
    // the controller's socket at it through a mocked net.connect.
    const received = [];
    const printer = net.createServer((s) => s.on('data', (d) => received.push(d)));
    await new Promise((r) => printer.listen(0, '127.0.0.1', r));
    const realConnect = net.connect;
    const spy = jest.spyOn(net, 'connect').mockImplementation((opts) => realConnect({ host: '127.0.0.1', port: printer.address().port }));
    try {
      const { token } = await createActiveStoreWithAdmin();
      const bytes = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00]);
      const res = await request().post('/api/print/network').set('Authorization', `Bearer ${token}`)
        .send({ host: '192.168.1.50', port: 9100, data: bytes.toString('base64') });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith({ host: '192.168.1.50', port: 9100 });
      await new Promise((r) => setTimeout(r, 50));
      expect(Buffer.concat(received)).toEqual(bytes);
    } finally {
      spy.mockRestore();
      printer.close();
    }
  });

  it('says clearly when the printer is unreachable', async () => {
    const realConnect = net.connect;
    const spy = jest.spyOn(net, 'connect').mockImplementation(() => realConnect({ host: '127.0.0.1', port: 1 }));
    try {
      const { token } = await createActiveStoreWithAdmin();
      const res = await request().post('/api/print/network').set('Authorization', `Bearer ${token}`)
        .send({ host: '192.168.1.50', data: 'AA==' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Could not reach the printer/);
    } finally { spy.mockRestore(); }
  });
});

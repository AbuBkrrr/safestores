const net = require('net');
const { startEmbeddedServer, DEFAULT_PORT } = require('../server/embeddedServer');

function occupyPort(port) {
  return new Promise((resolve) => {
    const blocker = net.createServer();
    blocker.listen(port, '0.0.0.0', () => resolve(blocker));
  });
}

describe('embeddedServer: startEmbeddedServer', () => {
  it('binds to the requested port on all interfaces', async () => {
    const { port, server } = await startEmbeddedServer(4777);
    expect(port).toBe(4777);
    expect(server.address().address).toBe('0.0.0.0');
    server.close();
  });

  it('falls back to a random free port when the requested one is already taken', async () => {
    const blocker = await occupyPort(4778);
    try {
      const { port, server } = await startEmbeddedServer(4778);
      expect(port).not.toBe(4778);
      expect(port).toBeGreaterThan(0);
      server.close();
    } finally {
      blocker.close();
    }
  });

  it('the returned server actually serves real requests (not just a bound socket)', async () => {
    const { port, server } = await startEmbeddedServer(4779);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/currency`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

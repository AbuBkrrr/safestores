// Sends raw ESC/POS bytes to a Wi-Fi / network receipt printer (the usual
// "raw TCP" port 9100). Browsers can't open TCP sockets, so the shop computer
// does it for every device in the shop: the till on a tablet or phone posts
// the bytes here and this server forwards them to the printer on the shop
// network. Only private (shop-network) addresses are allowed.
const net = require('net');

function isPrivateIPv4(host) {
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function sendToPrinter(host, port, bytes, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(bytes, () => resolve()));
  });
}

async function printNetwork(req, res) {
  const host = String(req.body?.host || '').trim();
  const port = req.body?.port ? Number(req.body.port) : 9100;
  const data = String(req.body?.data || '');
  if (!isPrivateIPv4(host)) {
    return res.status(400).json({ error: 'Enter the printer\'s shop-network IP address, e.g. 192.168.1.50' });
  }
  if (!Number.isInteger(port) || port < 9100 || port > 9109) {
    return res.status(400).json({ error: 'Printer port must be between 9100 and 9109 (usually 9100)' });
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 512 * 1024) return res.status(400).json({ error: 'Nothing to print' });
  try {
    await sendToPrinter(host, port, bytes);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({
      error: `Could not reach the printer at ${host}:${port}. Check it is switched on and on the shop Wi-Fi.`,
    });
  }
}

module.exports = { printNetwork, isPrivateIPv4 };

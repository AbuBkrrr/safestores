// ------------------------------------------------------------
// LAN peer discovery via UDP broadcast.
//
// Every device running the desktop edition periodically broadcasts a small
// "I'm here" packet on the local network and listens for the same from
// others. Two installs only actually sync with each other if they
// announce the SAME storeId — a device never cares about peers for a
// different store. The broadcast itself carries no secret (just storeId +
// port); the actual data exchange afterward is authenticated with the
// store's sync_key over HTTP (see syncAgent.js), so an eavesdropper on the
// LAN learns "a SAFE Stores device for store X exists at this address",
// nothing more.
//
// Caveat worth knowing for real-world deployment: some Wi-Fi routers
// (especially "guest" networks or ones with AP/client isolation enabled)
// block broadcast/multicast traffic between clients for security. If
// devices aren't finding each other, that's the first thing to check —
// switch to the main network or disable client isolation.
// ------------------------------------------------------------

const dgram = require('dgram');

const BROADCAST_PORT = 41234;
const ANNOUNCE_INTERVAL_MS = 5000;
const PEER_STALE_MS = 20000; // drop a peer we haven't heard from in this long

function startDiscovery({ getAnnouncement }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const peers = new Map(); // key: `${storeId}|${ip}:${port}` -> { storeId, ip, port, lastSeen }

  socket.on('message', (msg, rinfo) => {
    let payload;
    try { payload = JSON.parse(msg.toString()); } catch { return; }
    if (payload?.type !== 'safe-stores-announce' || !payload.storeId || !payload.port) return;

    const key = `${payload.storeId}|${rinfo.address}:${payload.port}`;
    peers.set(key, { storeId: payload.storeId, ip: rinfo.address, port: payload.port, lastSeen: Date.now() });
  });

  socket.on('error', (err) => {
    console.error('[lan-discovery] socket error', err.message);
  });

  socket.bind(BROADCAST_PORT, () => {
    try { socket.setBroadcast(true); } catch { /* not fatal — we can still receive */ }
  });

  const announceTimer = setInterval(() => {
    const announcement = getAnnouncement();
    if (!announcement) return; // store not set up yet — nothing to announce
    const message = Buffer.from(JSON.stringify({ type: 'safe-stores-announce', ...announcement }));
    socket.send(message, 0, message.length, BROADCAST_PORT, '255.255.255.255', (err) => {
      if (err) console.error('[lan-discovery] broadcast failed', err.message);
    });
  }, ANNOUNCE_INTERVAL_MS);

  function getPeersForStore(storeId) {
    const cutoff = Date.now() - PEER_STALE_MS;
    return Array.from(peers.values()).filter((p) => p.storeId === storeId && p.lastSeen >= cutoff);
  }

  function stop() {
    clearInterval(announceTimer);
    socket.close();
  }

  return { getPeersForStore, stop };
}

module.exports = { startDiscovery };

// ------------------------------------------------------------
// Realtime layer — Socket.IO
//
// Every authenticated browser tab connects once and joins a room
// scoped to its store (`store:<storeId>`). Whenever any user in that
// store records a stock arrival, movement, shelf audit, receipt
// action, product change, or camera-gallery change, the relevant
// controller calls `emitToStore(storeId, event, payload)` and every
// other tab open on that store — regardless of which user or role —
// receives the update instantly and refreshes its view. This is what
// keeps multiple staff members who are stock-taking at the same time
// in sync without needing to manually refresh.
// ------------------------------------------------------------

const { Server } = require('socket.io');
const { verifyToken } = require('./utils/jwt');
const { buildCorsOptions } = require('./config/corsOrigins');

let io = null;

function init(httpServer) {
  const { origin } = buildCorsOptions();
  io = new Server(httpServer, {
    cors: { origin, credentials: true },
  });

  // Several backend copies behind a load balancer: relay events between
  // them through Postgres LISTEN/NOTIFY so a store's users get updates
  // whichever copy they're connected to. Off in tests / when disabled.
  if (process.env.NODE_ENV === 'production' && process.env.REALTIME_ADAPTER !== 'none') {
    try {
      const { createAdapter } = require('@socket.io/postgres-adapter');
      const { Pool } = require('pg');
      const adapterPool = new Pool({ ...require('./config/db').buildPoolConfig(), max: 2 });
      adapterPool.on('error', (err) => console.error('Realtime adapter pool error:', err.message));
      io.adapter(createAdapter(adapterPool));
      console.log('🔁 Realtime events shared across instances (Postgres adapter).');
    } catch (err) {
      console.error('Realtime adapter not enabled:', err.message);
    }
  }

  // Authenticate the socket the same way REST requests are authenticated:
  // a JWT is passed in the handshake, not a cookie/session.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Missing auth token'));
      socket.user = verifyToken(token);
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const { storeId, role, sub } = socket.user;

    // Super admins aren't scoped to a single store, so they don't join a
    // store room — nothing in the stock-taking flow is relevant to them.
    if (storeId) {
      socket.join(`store:${storeId}`);
      socket.to(`store:${storeId}`).emit('presence:joined', { userId: sub, role });
    }

    // ---- Support calls (voice + screen share + guided control) ----
    // Each person has a private room; super admins also share a 'support'
    // room. A store user can only reach a super admin (admin:<id> rooms only
    // super admins join) and a super admin can only reach one user, so call
    // signals never leak to anyone else. The server just relays; the audio and
    // video go directly between the two browsers (WebRTC).
    const isSupport = role === 'super_admin';
    socket.join(isSupport ? `admin:${sub}` : `user:${sub}`);
    if (isSupport) socket.join('support');
    const name = String(socket.handshake.auth?.name || '').slice(0, 80);
    const routeTo = (to) => (typeof to === 'string' && /^[0-9a-f-]{36}$/i.test(to) ? (isSupport ? `user:${to}` : `admin:${to}`) : null);
    if (!isSupport && storeId) {
      // A store user asks for help: ring every support person online.
      socket.on('call:request', (p = {}) => {
        io.to('support').emit('call:incoming', { from: sub, storeId, role, name: String(p.name || name).slice(0, 80), storeName: String(p.storeName || '').slice(0, 120), at: Date.now() });
      });
      socket.on('call:cancel', () => io.to('support').emit('call:cancelled', { from: sub }));
    }
    if (isSupport) {
      // Support rings a store user (from a ticket), or accepts their request.
      socket.on('call:ring', (p = {}) => { const r = routeTo(p.to); if (r) io.to(r).emit('call:ringing', { from: sub, name: String(p.name || name || 'SAFE Stores support').slice(0, 80) }); });
      socket.on('call:accept', (p = {}) => {
        const r = routeTo(p.to); if (!r) return;
        io.to(r).emit('call:accepted', { from: sub, name: String(p.name || name || 'SAFE Stores support').slice(0, 80) });
        socket.to('support').emit('call:taken', { from: p.to }); // other support staff stop ringing
      });
    } else {
      socket.on('call:answer', (p = {}) => { const r = routeTo(p.to); if (r) io.to(r).emit('call:answered', { from: sub, storeId, name }); });
    }
    socket.on('call:signal', (p = {}) => { const r = routeTo(p.to); if (r && p.data && JSON.stringify(p.data).length < 100000) io.to(r).emit('call:signal', { from: sub, data: p.data }); });
    socket.on('call:end', (p = {}) => { const r = routeTo(p.to); if (r) io.to(r).emit('call:ended', { from: sub }); });

    socket.on('disconnect', () => {
      if (storeId) {
        socket.to(`store:${storeId}`).emit('presence:left', { userId: sub, role });
        socket.to(`store:${storeId}`).emit('section:release', { userId: sub, all: true });
      }
    });

    // Ephemeral, not persisted anywhere — just a "heads up, I'm counting
    // this item/section right now" signal so a second stock-taker sees
    // it's already being worked and can pick something else instead of
    // duplicating the count. userName/productName come from the client
    // since they're informational only, not a security-relevant claim.
    socket.on('section:claim', (payload) => {
      if (!storeId) return;
      socket.to(`store:${storeId}`).emit('section:claim', { ...payload, userId: sub });
    });
    socket.on('section:release', (payload) => {
      if (!storeId) return;
      socket.to(`store:${storeId}`).emit('section:release', { ...payload, userId: sub });
    });
  });

  return io;
}

/** Broadcast an event to every connected client for a given store. */
function emitToStore(storeId, event, payload) {
  if (!io || !storeId) return;
  io.to(`store:${storeId}`).emit(event, payload);
}

module.exports = { init, emitToStore };

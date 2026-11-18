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

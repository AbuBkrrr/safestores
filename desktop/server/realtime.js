// ------------------------------------------------------------
// Realtime layer — Socket.IO, desktop/LAN counterpart of
// backend/src/realtime.js. Same behavior: every authenticated browser tab
// (whether it's the Electron window itself or a teammate's phone/laptop
// on the same LAN hitting this device's IP) joins a room scoped to this
// store, and any stock arrival/movement/order/receipt/product change
// broadcasts instantly to every other open tab — this is what lets
// multiple people work the same store at once (checkout on one device,
// receiving stock on another, shelf-counting on a third) without anyone
// needing to manually refresh.
//
// No CORS handling needed here unlike the cloud version — the frontend is
// served by this same Express server, so every connection (LAN or local)
// is same-origin by construction.
// ------------------------------------------------------------

const { Server } = require('socket.io');
const { verifyToken } = require('./utils/jwt');

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {});

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

    // A local super_admin session isn't scoped to a single store — nothing
    // in the stock-taking/order flow is relevant to it.
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

    // Ephemeral "I'm counting this item right now" signal for the shelf
    // audit page — not persisted anywhere, just relayed to other tabs.
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

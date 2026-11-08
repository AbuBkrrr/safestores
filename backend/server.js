require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');
validateEnv(); // exits the process early if required config is missing/unsafe

const http = require('http');
const { createApp } = require('./src/app');
const { bootstrapSuperAdmin } = require('./src/db/bootstrap');
const realtime = require('./src/realtime');
const { startBillingJob } = require('./src/jobs/billingJob');
const { startCycleCountJob } = require('./src/jobs/cycleCountJob');
const { startExpiryJob } = require('./src/jobs/expiryJob');
const errorMonitoring = require('./src/utils/errorMonitoring');

// Catches crashes Express's own error handler never sees at all — a
// throw inside a setInterval callback (the background jobs above), an
// unawaited rejected promise anywhere, etc. Without this, these currently
// only ever reach a console.error a human has to be watching logs to see.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  errorMonitoring.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  errorMonitoring.captureException(err);
  // Deliberately NOT exiting here: Node's own guidance is to restart the
  // process after an uncaughtException since state may be corrupted, but
  // this app has no supervisor/orchestrator guarantee of a restart in
  // every deployment target it supports (a bare VPS running `node
  // server.js` directly has none) — crashing on every uncaught error
  // would turn a single bad request into a full outage. The error is
  // still reported and logged either way.
});

const app = createApp();
const PORT = process.env.PORT || 4000;

// Wrap Express in a plain HTTP server so Socket.IO can attach to the same
// port — the REST API and the realtime layer are served from one process.
// This traditional-hosting entry point (Render/Fly/a VPS/your own box) is
// one of two equally-supported ways to run this service — see
// netlify/functions/api.js for the serverless alternative, and that
// file's header for what's different about it (mainly: no realtime).
const server = http.createServer(app);
realtime.init(server);
const stopBillingJob = startBillingJob();
const stopCycleCountJob = startCycleCountJob();
const stopExpiryJob = startExpiryJob();

bootstrapSuperAdmin()
  .catch((err) => console.error('Bootstrap failed:', err.message))
  .finally(() => {
    server.listen(PORT, () => console.log(`🚀 SAFE Stores API (+ realtime) running on http://localhost:${PORT}`));
  });

// Graceful shutdown: stop accepting new connections and let in-flight
// requests finish before the process manager/host kills the process
// (Render, Railway, Docker, and systemd all send SIGTERM before SIGKILL).
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  stopBillingJob();
  stopCycleCountJob();
  stopExpiryJob();
  server.close(() => {
    console.log('HTTP server closed.');
    const { pool } = require('./src/config/db');
    pool.end().then(() => {
      console.log('Database pool closed.');
      process.exit(0);
    });
  });
  // Force-exit if something hangs longer than 10s.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

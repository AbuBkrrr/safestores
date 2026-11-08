// ------------------------------------------------------------
// Netlify Function entry point — the serverless alternative to
// server.js. Wraps the exact same Express app (src/app.js) with
// serverless-http, so every route behaves identically to the traditional
// deployment. What's genuinely different here:
//
//   - No realtime (Socket.IO). Netlify Functions are stateless/per-request
//     — there's no process alive between requests to hold a WebSocket
//     open. The frontend's SocketContext already degrades gracefully
//     when it can't connect (falls back to whatever manual-refresh
//     behavior each page already has) — see that file's header. In
//     practice this only affects the marketplace order-fulfillment and
//     support-ticket live-update notifications; nothing else in this
//     cloud sliver uses realtime.
//   - No in-process billing job loop. See netlify/functions/billing-cron.js
//     for the scheduled-function equivalent of billingJob.js's interval.
//   - bootstrapSuperAdmin() (creating the very first Super Admin account)
//     doesn't run automatically here the way it does in server.js's
//     startup sequence — call POST /api/setup/super-admin once yourself
//     after your first deploy instead (same self-locking endpoint either
//     way — see app.js's comment on it).
//   - Connection pooling: set DB_POOL_MAX low (1–2) in this environment.
//     Every cold start is a fresh process with its own Pool; a high max
//     here multiplies fast under concurrent invocations and can exhaust
//     Supabase's own connection limit. Point DATABASE_URL at Supabase's
//     transaction-mode pooler (port 6543, not 5432) — this codebase's
//     queries never use named prepared statements, so they're already
//     compatible with PgBouncer transaction pooling.
// ------------------------------------------------------------

const serverless = require('serverless-http');
const { createApp } = require('../../src/app');

const app = createApp();

exports.handler = serverless(app);

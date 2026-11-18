// Leader election for running several backend copies behind a load balancer.
//
// Scheduled jobs (billing, daily summaries, expiry, cycle counts, retention)
// must run on exactly ONE copy, or stores get billed twice. Each copy tries
// to take a Postgres session advisory lock on its own dedicated connection;
// whoever holds it runs the jobs. If that copy dies, Postgres drops its
// connection and the lock, and another copy takes over within RETRY_MS.
const { Client } = require('pg');
const { buildPoolConfig } = require('../config/db');

const LOCK_KEY = 727001; // arbitrary, app-wide constant
const RETRY_MS = 30 * 1000;

function startWhenLeader(onLeader) {
  // Tests and single-process setups can skip the election entirely.
  if (process.env.RUN_JOBS === 'always') { onLeader(); return () => {}; }
  if (process.env.RUN_JOBS === 'never') return () => {};

  let client = null;
  let timer = null;
  let stopped = false;
  let isLeader = false;

  const attempt = async () => {
    if (stopped || isLeader) return;
    try {
      client = new Client(buildPoolConfig());
      client.on('error', () => {}); // connection loss → lock is gone; handled below
      client.on('end', () => {
        if (isLeader && !stopped) {
          // Lost the lock connection: exit so the orchestrator restarts us
          // rather than risk two copies both believing they lead.
          console.error('Lost job-leader database connection — restarting.');
          process.exit(1);
        }
      });
      await client.connect();
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
      if (rows[0].ok) {
        isLeader = true;
        console.log('🗳️  This instance runs the scheduled jobs (job leader).');
        onLeader();
        return;
      }
      await client.end().catch(() => {});
      client = null;
    } catch (err) {
      console.error('Job-leader election failed:', err.message);
      if (client) await client.end().catch(() => {});
      client = null;
    }
    if (!stopped) timer = setTimeout(attempt, RETRY_MS);
  };
  attempt();

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (client) client.end().catch(() => {});
  };
}

module.exports = { startWhenLeader, LOCK_KEY };

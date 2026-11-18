// ------------------------------------------------------------
// Netlify Scheduled Function — the serverless equivalent of
// cycleCountJob.js's setInterval loop, which only exists in server.js's
// always-on process and never runs at all under the Netlify deployment
// path. See billing-cron.js's header for the full rationale — same
// pattern, just a different job.
// ------------------------------------------------------------

const { runCycleCountSweep } = require('../../src/jobs/cycleCountJob');

exports.handler = async () => {
  try {
    await runCycleCountSweep();
    return { statusCode: 200, body: 'Cycle count sweep completed' };
  } catch (err) {
    console.error('[cycle-count-cron] failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.config = {
  schedule: '@daily',
};

// ------------------------------------------------------------
// Netlify Scheduled Function — serverless equivalent of expiryJob.js's
// setInterval loop, which only exists in server.js's always-on process.
// See billing-cron.js's header for the full rationale.
// ------------------------------------------------------------

const { runExpirySweep } = require('../../src/jobs/expiryJob');

exports.handler = async () => {
  try {
    await runExpirySweep();
    return { statusCode: 200, body: 'Expiry sweep completed' };
  } catch (err) {
    console.error('[expiry-cron] failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.config = {
  schedule: '@daily',
};

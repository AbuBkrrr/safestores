// ------------------------------------------------------------
// Netlify Scheduled Function — the serverless equivalent of
// billingJob.js's setInterval loop, which only exists in server.js's
// always-on process and never runs at all under the Netlify deployment
// path. Configure the schedule in Netlify's dashboard (Functions →
// this function → Scheduling), or via the `schedule` field below —
// once daily is plenty, matching billingJob.js's own interval.
//
// Shares the exact same billing logic (runBillingCycle) as the
// traditional deployment's interval loop — there's no separate
// "serverless billing rules", just a different trigger mechanism.
// ------------------------------------------------------------

const { runBillingCycle } = require('../../src/jobs/billingJob');

exports.handler = async () => {
  try {
    await runBillingCycle();
    return { statusCode: 200, body: 'Billing cycle completed' };
  } catch (err) {
    console.error('[billing-cron] failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

// Netlify reads this from the file when scheduling is configured via
// netlify.toml instead of the dashboard — see that file if you'd rather
// manage the schedule as code.
exports.config = {
  schedule: '@daily',
};

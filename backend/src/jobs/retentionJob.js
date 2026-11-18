// ------------------------------------------------------------
// Data-retention sweep: permanently deletes stores whose 30-day closure
// grace period has ended, and prunes expired one-time auth tokens.
// Runs hourly from server.js; idempotent, so a missed run just catches up.
// ------------------------------------------------------------
const { purgeDueStoreDeletions } = require('../controllers/accountController');
const { captureException } = require('../utils/errorMonitoring');

async function runRetentionSweep() {
  try {
    return await purgeDueStoreDeletions();
  } catch (err) {
    console.error('Retention sweep failed:', err.message);
    captureException(err);
    return 0;
  }
}

function startRetentionJob(intervalMs = 60 * 60 * 1000) {
  const first = setTimeout(runRetentionSweep, 30 * 1000);
  const interval = setInterval(runRetentionSweep, intervalMs);
  return () => { clearTimeout(first); clearInterval(interval); };
}

module.exports = { startRetentionJob, runRetentionSweep };

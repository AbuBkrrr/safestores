// ------------------------------------------------------------
// End-of-day summary email. Hourly sweep: any active store where it is
// now 21:00–21:59 local time and today's summary hasn't gone out gets one,
// sent to its active admins with verified email addresses. A no-op when
// SMTP isn't configured. Idempotent via stores.last_summary_on.
// ------------------------------------------------------------
const db = require('../config/db');
const { sendMail, isConfigured } = require('../utils/mailer');
const { buildDailyReport } = require('../controllers/shiftsController');
const { formatMoney } = require('../utils/money');
const { captureException } = require('../utils/errorMonitoring');

const SEND_HOUR = 21;

async function storesDue() {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.timezone, (now() AT TIME ZONE s.timezone)::date::text AS local_day,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default'
     WHERE s.subscription_status = 'active' AND s.daily_summary_enabled = true
       AND EXTRACT(HOUR FROM now() AT TIME ZONE s.timezone) = $1
       AND (s.last_summary_on IS NULL OR s.last_summary_on < (now() AT TIME ZONE s.timezone)::date)`,
    [SEND_HOUR]
  );
  return rows;
}

async function summaryFor(store) {
  const r = await buildDailyReport(store.id, store.local_day);
  const { rows: low } = await db.query(
    'SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND archived_at IS NULL AND shelf_qty <= reorder_level', [store.id]
  );
  const f = (n) => formatMoney(n, { code: store.currency_code, symbol: store.currency_symbol });
  const lines = [
    `${store.name} — ${r.date}`,
    '',
    `Sales: ${r.orders} · ${f(r.gross)}`,
    `Refunds: ${r.refunds.count} · ${f(r.refunds.total)}`,
    `Net: ${f(r.net)}`,
    ...(r.byMethod.length ? ['', 'By payment method:', ...r.byMethod.map((m) => `  ${m.method}: ${f(m.total)}`)] : []),
    ...(r.topItems.length ? ['', 'Top items:', ...r.topItems.slice(0, 5).map((i) => `  ${i.name} × ${i.units}`)] : []),
    '',
    `Products at or below reorder level: ${low[0].n}`,
  ];
  return { subject: `${store.name}: today's sales ${f(r.gross)}`, text: lines.join('\n') };
}

async function runDailySummarySweep() {
  if (!isConfigured) return 0;
  let sent = 0;
  try {
    for (const store of await storesDue()) {
      const { rows: admins } = await db.query(
        `SELECT email FROM users WHERE store_id = $1 AND role = 'admin' AND status = 'active' AND email_verified_at IS NOT NULL`, [store.id]
      );
      // Mark first so a slow mail server can't cause a duplicate next hour.
      await db.query('UPDATE stores SET last_summary_on = $1::date WHERE id = $2', [store.local_day, store.id]);
      if (!admins.length) continue;
      const msg = await summaryFor(store);
      for (const a of admins) {
        // eslint-disable-next-line no-await-in-loop
        if (await sendMail({ to: a.email, ...msg })) sent += 1;
      }
    }
  } catch (err) {
    console.error('Daily summary sweep failed:', err.message);
    captureException(err);
  }
  return sent;
}

function startDailySummaryJob(intervalMs = 15 * 60 * 1000) {
  const interval = setInterval(runDailySummarySweep, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { startDailySummaryJob, runDailySummarySweep, summaryFor };

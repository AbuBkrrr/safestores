// Time-zone helpers for SQLite, which has no AT TIME ZONE: dates are
// stored as UTC ISO strings and converted to the store's local calendar
// day / hour in JS with the platform's own IANA data (Intl).

function localParts(iso, timeZone) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

function localDate(iso, timeZone) { return localParts(iso, timeZone).date; }
function localHour(iso, timeZone) { return localParts(iso, timeZone).hour; }
function todayIn(timeZone) { return localDate(new Date().toISOString(), timeZone); }

/** A UTC ISO window that safely contains every instant of local day `date` (±14h covers all zones). */
function utcWindowFor(date) {
  const start = new Date(`${date}T00:00:00Z`).getTime() - 14 * 3600 * 1000;
  const end = new Date(`${date}T23:59:59.999Z`).getTime() + 14 * 3600 * 1000;
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const CURRENCIES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);
function symbolFor(code) {
  if (CURRENCIES.size && !CURRENCIES.has(code)) return null;
  try {
    const part = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((p) => p.type === 'currency');
    return part?.value || code;
  } catch { return null; }
}

module.exports = { localDate, localHour, todayIn, utcWindowFor, isValidTimezone, symbolFor };

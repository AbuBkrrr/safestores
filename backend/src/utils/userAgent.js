// Small, dependency-free reading of a browser's user-agent string: what kind
// of device, which phone model, system, browser, and which app's built-in
// browser it was opened in (WhatsApp, Facebook, Instagram…). Good enough for
// marketing reports; not a security check.
const ct = require('countries-and-timezones');

function parseUserAgent(ua = '') {
  const s = String(ua);
  const inApp = /WhatsApp/i.test(s) ? 'WhatsApp'
    : /FBAN|FBAV|FB_IAB/i.test(s) ? 'Facebook'
    : /Instagram/i.test(s) ? 'Instagram'
    : /TikTok|musical_ly|BytedanceWebview/i.test(s) ? 'TikTok'
    : /Twitter/i.test(s) ? 'X (Twitter)'
    : /LinkedInApp/i.test(s) ? 'LinkedIn'
    : /Telegram/i.test(s) ? 'Telegram'
    : /Snapchat/i.test(s) ? 'Snapchat'
    : /Line\//i.test(s) ? 'LINE' : null;

  let os = 'Other'; let model = null;
  if (/Android/i.test(s)) {
    os = `Android ${(s.match(/Android ([\d.]+)/i) || [])[1] || ''}`.trim();
    const m = s.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build\/|\))/i);
    if (m && !/^(K|wv|Linux)$/i.test(m[1].trim())) model = m[1].trim();
  } else if (/iPhone|iPad|iPod/i.test(s)) {
    os = `iOS ${((s.match(/OS ([\d_]+)/) || [])[1] || '').replace(/_/g, '.')}`.trim();
    model = (s.match(/iPhone|iPad|iPod/) || [])[0];
  } else if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/Mac OS X/i.test(s)) os = 'macOS';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  const browser = inApp ? `${inApp} in-app`
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /OPR\/|Opera/i.test(s) ? 'Opera'
    : /Edg\//i.test(s) ? 'Edge'
    : /CriOS|Chrome\//i.test(s) ? 'Chrome'
    : /FxiOS|Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari' : 'Other';

  const deviceType = /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) ? 'tablet'
    : /Mobi|iPhone|Android/i.test(s) ? 'phone'
    : /bot|crawl|spider|preview|facebookexternalhit|WhatsApp\/\d/i.test(s) && !/Mozilla/i.test(s) ? 'bot' : 'computer';

  return { deviceType, os, browser, model, inApp };
}

/** Country from the request (proxy/CDN header) or else from the browser's time zone. */
function countryOf(req, timezone) {
  const code = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(code) && code !== 'XX') {
    const c = ct.getCountry(code);
    if (c) return { country: c.name, countryCode: code };
  }
  try {
    const c = timezone && ct.getCountryForTimezone(timezone);
    if (c) return { country: c.name, countryCode: c.id };
  } catch { /* unknown zone */ }
  return { country: null, countryCode: null };
}

module.exports = { parseUserAgent, countryOf };

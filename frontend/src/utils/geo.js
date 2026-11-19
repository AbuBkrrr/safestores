// The phone's location, only for the shop's "in-store only" lock. It is
// asked for only after the server says the shop needs it, then reused for a
// few minutes so every sale doesn't wait on GPS.

const FRESH_MS = 2 * 60 * 1000; // reuse a fix this long for live requests
const KEEP_MS = 10 * 60 * 1000; // stamp offline (queued) actions with a fix up to this old
let last = null; // { lat, lng, accuracy, at }

export function lastFix(maxAgeMs = FRESH_MS) {
  return last && Date.now() - last.at <= maxAgeMs ? last : null;
}

/** A fix suitable for stamping on an action queued while offline. */
export function fixForQueue() {
  return lastFix(KEEP_MS);
}

export function geoHeaders(fix) {
  if (!fix) return {};
  return {
    'X-Geo-Lat': String(fix.lat),
    'X-Geo-Lng': String(fix.lng),
    'X-Geo-Accuracy': String(Math.round(fix.accuracy || 0)),
  };
}

/** Ask the phone where it is. Resolves null if location is off, refused or slow. */
export function getFix({ timeoutMs = 10000 } = {}) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
        resolve(last);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

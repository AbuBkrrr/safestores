// Is this request coming from inside the shop?
// Two ways to pass: the request comes from one of the shop's saved internet
// connections, or the phone sends a GPS fix inside the shop's radius.

/** The address as we compare it: IPv4 exact; IPv6 by its /64 network, since
 *  phones and routers rotate the last half of an IPv6 address. */
function networkKey(ip) {
  let a = String(ip || '').trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (!a.includes(':')) return a;
  if (a.endsWith('::/64')) return a;
  const [head, tail] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${full.slice(0, 4).map((h) => (h || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function distanceMetres(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const MAX_ACCURACY_M = 250; // a fix vaguer than this can't place someone in a shop

/** { ok, how, distance? } — how = 'network' | 'gps' | the reason it failed. */
function checkOnsite(store, { ip, lat, lng, accuracy }) {
  const nets = Array.isArray(store.onsite_networks) ? store.onsite_networks : [];
  if (ip && nets.some((n) => networkKey(n.ip) === networkKey(ip))) return { ok: true, how: 'network' };
  if (store.onsite_lat == null || store.onsite_lng == null) return { ok: false, how: 'not_on_shop_network' };
  if (lat == null || lng == null || lat === '' || lng === '') return { ok: false, how: 'location_needed' };
  const la = Number(lat), ln = Number(lng), acc = accuracy == null || accuracy === '' ? NaN : Number(accuracy);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return { ok: false, how: 'location_needed' };
  if (Number.isFinite(acc) && acc > MAX_ACCURACY_M) return { ok: false, how: 'location_too_vague' };
  const d = distanceMetres(Number(store.onsite_lat), Number(store.onsite_lng), la, ln);
  const slack = Number.isFinite(acc) ? Math.min(Math.max(acc, 0), 50) : 0;
  return d <= Number(store.onsite_radius_m) + slack
    ? { ok: true, how: 'gps', distance: Math.round(d) }
    : { ok: false, how: 'outside_radius', distance: Math.round(d) };
}

module.exports = { networkKey, distanceMetres, checkOnsite, MAX_ACCURACY_M };

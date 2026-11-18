// Store custom domains: a shop's own domain (shop.example.com) pointed at
// this server opens that store's storefront. Used by the TLS "ask" check
// (so Caddy only gets certificates for real shops), CORS, and the frontend.
const dns = require('dns').promises;
const db = require('../config/db');

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The host this platform itself runs on (from FRONTEND_URL), which stores can't claim. */
function platformHosts() {
  return (process.env.FRONTEND_URL || '').split(',').map((u) => { try { return new URL(u.trim()).hostname; } catch { return null; } }).filter(Boolean);
}

/** Where a store should point its DNS (CNAME target). */
function domainTarget() {
  return process.env.CUSTOM_DOMAIN_TARGET || platformHosts()[0] || 'localhost';
}

/** Returns { value } (normalised host, or null to clear) or { error }. */
function parseCustomDomain(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null };
  let h = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!HOST_RE.test(h)) return { error: 'Enter a domain like shop.yourbusiness.com (no https://, no slashes)' };
  const base = platformHosts().map((p) => p.split('.').slice(-3).join('.'));
  if (platformHosts().includes(h) || base.some((b) => h === b || h.endsWith(`.${b}`))) {
    return { error: "That's a SAFE Stores address — use your own domain, or set a shop address instead" };
  }
  return { value: h };
}

// Small cache: the CORS check runs on every cross-origin request.
const cache = new Map(); // host -> { storeId, at }
const TTL = 60 * 1000;
function clearDomainCache() { cache.clear(); }

/** Active, listed store for a host, or null. */
async function storeForDomain(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < TTL) return hit.store;
  const { rows } = await db.query(
    `SELECT id, shop_slug FROM stores WHERE custom_domain = $1 AND subscription_status = 'active' AND marketplace_enabled = true`, [h]
  );
  const store = rows[0] || null;
  cache.set(h, { store, at: Date.now() });
  return store;
}

/** Does the domain's DNS reach the same server as the platform? */
async function dnsPointsHere(host) {
  const v4 = async (n) => { try { return await dns.resolve4(n); } catch { return []; } };
  const [mine, theirs] = await Promise.all([v4(domainTarget()), v4(host)]);
  return mine.length > 0 && theirs.some((ip) => mine.includes(ip));
}

module.exports = { parseCustomDomain, storeForDomain, clearDomainCache, domainTarget, dnsPointsHere };

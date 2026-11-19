// The name the app shows everywhere. A store's own build (see
// templates/store-app) sets VITE_BRAND_NAME to the store's name, so that
// copy of the app never mentions the platform; the shared web app keeps the
// platform name.
export const PLATFORM_NAME = 'SAFE Stores';
export const BRAND = (import.meta.env.VITE_BRAND_NAME || '').trim() || PLATFORM_NAME;
export const WHITE_LABEL = Boolean((import.meta.env.VITE_BRAND_NAME || '').trim());

/** Puts the store's name wherever the platform name appears in text. */
export function brandText(text) {
  return WHITE_LABEL && typeof text === 'string' && BRAND !== PLATFORM_NAME ? text.split(PLATFORM_NAME).join(BRAND) : text;
}

/** Same, through a whole translation tree. */
export function brandTree(node) {
  if (!WHITE_LABEL) return node;
  if (typeof node === 'string') return brandText(node);
  if (Array.isArray(node)) return node.map(brandTree);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, brandTree(v)]));
  }
  return node;
}

// Per-device display preferences: theme (system / light / dark) and text
// size. Stored in localStorage (a convenience, not data), applied to <html>
// as data-theme / data-text-size so CSS does the rest.

const THEME_KEY = 'ss_theme';
const SIZE_KEY = 'ss_text_size';

function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode / blocked storage */ }
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePref() { return read(THEME_KEY, 'system'); }
export function getTextSize() { return read(SIZE_KEY, '100'); }

export function applyTheme(pref = getThemePref()) {
  if (typeof document === 'undefined') return;
  const dark = pref === 'dark' || (pref === 'system' && media?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#11181d' : '#0f7180');
}

export function setThemePref(pref) { write(THEME_KEY, pref); applyTheme(pref); }

export function applyTextSize(size = getTextSize()) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.textSize = size;
}
export function setTextSize(size) { write(SIZE_KEY, size); applyTextSize(size); }

export function initPreferences() {
  applyTheme();
  applyTextSize();
  media?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
}

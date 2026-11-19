import { useEffect } from 'react';

export const SHOP_FONTS = ['Poppins', 'Montserrat', 'Nunito', 'Playfair Display', 'Merriweather', 'Lobster', 'Oswald', 'Quicksand'];

const LIGHT = { '--bg': '#f5f7f8', '--panel': '#ffffff', '--text': '#182026', '--muted': '#64717c', '--line': '#dce3e7' };
const DARK = { '--bg': '#11181d', '--panel': '#1a242b', '--text': '#e6edf1', '--muted': '#9aaab5', '--line': '#2c3a43' };

// Darken/lighten a #rrggbb colour by amt (-1..1).
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(Math.min(255, Math.max(0, amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}

/** CSS variables for a shop's branding, applied on the storefront wrapper. */
export function shopThemeVars(store) {
  if (!store) return {};
  const vars = { ...(store.shop_theme === 'light' ? LIGHT : store.shop_theme === 'dark' ? DARK : {}) };
  if (store.shop_brand_color) {
    vars['--primary'] = store.shop_brand_color;
    vars['--primary-dark'] = shade(store.shop_brand_color, -0.25);
    vars['--primary-light'] = shade(store.shop_brand_color, store.shop_theme === 'dark' ? -0.6 : 0.82);
  }
  if (store.shop_font) vars.fontFamily = `'${store.shop_font}', system-ui, sans-serif`;
  return vars;
}

/** Page background + web font for the shop while its storefront is open. */
export function useShopTheme(store) {
  const font = store?.shop_font;
  const bgColor = store?.shop_bg_color;
  const bgImage = store?.shop_bg_image_url;
  useEffect(() => {
    if (!font || !SHOP_FONTS.includes(font)) return undefined;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;600;700&display=swap`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [font]);
  useEffect(() => {
    if (!bgColor && !bgImage) return undefined;
    const b = document.body.style;
    const prev = { backgroundColor: b.backgroundColor, backgroundImage: b.backgroundImage, backgroundSize: b.backgroundSize, backgroundAttachment: b.backgroundAttachment, backgroundPosition: b.backgroundPosition };
    if (bgColor) b.backgroundColor = bgColor;
    if (bgImage) {
      b.backgroundImage = `url("${bgImage.replace(/"/g, '%22')}")`;
      b.backgroundSize = 'cover';
      b.backgroundAttachment = 'fixed';
      b.backgroundPosition = 'center';
    }
    return () => Object.assign(b, prev);
  }, [bgColor, bgImage]);
}

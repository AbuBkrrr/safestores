// Recognise a product from a camera picture — no barcode or label needed.
//
// Runs entirely on the device (phone, till or shop computer), so it works
// with no internet and sends no pictures anywhere. Each picture is turned
// into a small "look" fingerprint (~300 bytes): the item's colours, where
// those colours sit, and the shape of its edges and print. The plain table
// or counter behind the item is detected from the picture's border and
// ignored, so an item held up or laid on a flat surface both work.
//
// The shop teaches it: each product photo becomes a look, and every time
// the cashier confirms or picks an item from a camera picture, that
// picture is kept as another look. The more an item is sold this way, the
// better it is recognised (different angles, lighting, counters).

const SIZE = 64;
const HUE = 12; const SAT = 3; const VAL = 3; // colour histogram 108
const GRID = 4; const ORI = 8; // edge shape 128, colour layout 48

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h / 6, max ? d / max : 0, max / 255];
}

function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] /= s;
  return v;
}

/** Fingerprint of an image / video frame / canvas. Returns a Float32Array (unit length per part). */
export function lookOf(source) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const side = Math.min(sw, sh) * 0.85; // centre square: where the item is held
  ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // Background colour = median of the border pixels.
  const border = [[], [], []];
  for (let i = 0; i < SIZE; i += 1) {
    for (const [x, y] of [[i, 0], [i, SIZE - 1], [0, i], [SIZE - 1, i]]) {
      const o = (y * SIZE + x) * 4;
      border[0].push(px[o]); border[1].push(px[o + 1]); border[2].push(px[o + 2]);
    }
  }
  const bg = border.map((c) => c.sort((a, b) => a - b)[c.length >> 1]);

  // How much each pixel belongs to the item (far from the background colour).
  const w = new Float32Array(SIZE * SIZE);
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const o = i * 4;
    const d = Math.hypot(px[o] - bg[0], px[o + 1] - bg[1], px[o + 2] - bg[2]);
    w[i] = Math.min(1, Math.max(0.05, (d - 18) / 60));
    gray[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }

  const colour = new Float32Array(HUE * SAT * VAL);
  const layout = new Float32Array(GRID * GRID * 3);
  const layoutW = new Float32Array(GRID * GRID);
  const shape = new Float32Array(GRID * GRID * ORI);
  const cell = SIZE / GRID;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = y * SIZE + x; const o = i * 4; const wi = w[i];
      const [h, s, v] = rgbToHsv(px[o], px[o + 1], px[o + 2]);
      // Greys/blacks/whites have no reliable hue: give them their own bins.
      const hb = s < 0.15 ? 0 : 1 + Math.min(HUE - 2, Math.floor(h * (HUE - 1)));
      colour[(hb * SAT + Math.min(SAT - 1, Math.floor(s * SAT))) * VAL + Math.min(VAL - 1, Math.floor(v * VAL))] += wi;
      const g = Math.floor(y / cell) * GRID + Math.floor(x / cell);
      layout[g * 3] += px[o] * wi; layout[g * 3 + 1] += px[o + 1] * wi; layout[g * 3 + 2] += px[o + 2] * wi; layoutW[g] += wi;
      if (x > 0 && y > 0 && x < SIZE - 1 && y < SIZE - 1) {
        const gx = gray[i + 1] - gray[i - 1]; const gy = gray[i + SIZE] - gray[i - SIZE];
        const mag = Math.hypot(gx, gy);
        if (mag > 8) {
          const ang = (Math.atan2(gy, gx) + Math.PI) % Math.PI; // 0..PI, direction-free
          shape[g * ORI + Math.min(ORI - 1, Math.floor((ang / Math.PI) * ORI))] += mag * wi;
        }
      }
    }
  }
  for (let g = 0; g < GRID * GRID; g += 1) for (let c = 0; c < 3; c += 1) layout[g * 3 + c] /= (layoutW[g] || 1) * 255;
  for (let i = 0; i < colour.length; i += 1) colour[i] = Math.sqrt(colour[i]);
  for (let i = 0; i < shape.length; i += 1) shape[i] = Math.sqrt(shape[i]);
  const out = new Float32Array(colour.length + layout.length + shape.length);
  out.set(l2(colour), 0); out.set(l2(layout), colour.length); out.set(l2(shape), colour.length + layout.length);
  return out;
}

/** Compact text form for saving (each value 0..1 → one byte). */
export function packLook(v) {
  let s = '';
  for (let i = 0; i < v.length; i += 1) s += String.fromCharCode(Math.round(Math.min(1, Math.max(0, v[i])) * 255));
  return btoa(s);
}
export function unpackLook(text) {
  try {
    const s = atob(text);
    const v = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 1) v[i] = s.charCodeAt(i) / 255;
    return v;
  } catch { return null; }
}

const PARTS = [[0, HUE * SAT * VAL, 0.4], [HUE * SAT * VAL, HUE * SAT * VAL + GRID * GRID * 3, 0.25], [HUE * SAT * VAL + GRID * GRID * 3, Infinity, 0.35]];
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let total = 0;
  for (const [from, to, weight] of PARTS) {
    let dot = 0; let na = 0; let nb = 0;
    for (let i = from; i < Math.min(to, a.length); i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    total += weight * (dot / (Math.sqrt(na * nb) || 1));
  }
  return total;
}

/**
 * Best matching products for a picture.
 * looks: [{ product_id, sig }] — returns [{ productId, score }] best first (one per product).
 */
export function rankProducts(look, looks, limit = 3) {
  const best = new Map();
  for (const l of looks) {
    const v = l._v || (l._v = unpackLook(l.sig));
    const s = similarity(look, v);
    if (s > (best.get(l.product_id) || 0)) best.set(l.product_id, s);
  }
  return [...best.entries()].map(([productId, score]) => ({ productId, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Sure enough to add without asking: a strong match well ahead of the next product. */
export function isConfident(ranked) {
  if (!ranked[0]) return false;
  return ranked[0].score >= 0.9 && ranked[0].score - (ranked[1]?.score || 0) >= 0.05;
}

/** Look of an image file (e.g. a product photo being uploaded). */
export function lookOfFile(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { try { resolve(lookOf(img)); } catch { resolve(null); } URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

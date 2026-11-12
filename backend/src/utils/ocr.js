// ------------------------------------------------------------
// OCR extraction — real implementation using Tesseract.js.
//
// Tesseract.js runs entirely locally (no API key, no per-request cost).
// On first use it downloads the English trained-data model (~10-15MB)
// from Tesseract's CDN and caches it, so the machine running this needs
// outbound internet access once. To avoid that dependency at runtime,
// download eng.traineddata ahead of time and point TESSDATA_PATH at the
// folder containing it (see .env.example).
//
// The contract returned to callers: { rawText, items } where items is
// an array of { name, sku?, quantity, price }.
// ------------------------------------------------------------

const Tesseract = require('tesseract.js');

const NOISE_LINE = /^(total|subtotal|sub-total|tax|vat|gst|cash|change|balance|tender|card|amount due|thank you|receipt|invoice|date|time|cashier|store|address|phone|tel|www\.|http)/i;

// Matches a trailing money amount at the end of a line, e.g. "12.50", "$12.50"
const PRICE_AT_END = /(?:[$€£]\s?)?(\d{1,6}(?:[.,]\d{2}))\s*$/;
// Matches a leading quantity, e.g. "3 x", "3x", "3 "
const QTY_AT_START = /^\s*(\d{1,4})\s*(?:x|X|\*)?\s+/;
const QTY_X_ANYWHERE = /(\d{1,4})\s*(?:x|X|\*)\s*/;

/**
 * Turns raw OCR'd receipt text into structured line items.
 * Receipts vary wildly in layout, so this uses a best-effort heuristic:
 * skip obvious header/footer/total lines, then for each remaining line
 * pull a trailing price and a leading (or "N x") quantity, treating
 * whatever text remains as the product name.
 */
function parseReceiptText(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  const items = [];

  for (const line of lines) {
    if (NOISE_LINE.test(line)) continue;

    const priceMatch = line.match(PRICE_AT_END);
    if (!priceMatch) continue; // a real product line almost always ends in a price

    const price = parseFloat(priceMatch[1].replace(',', '.'));
    if (Number.isNaN(price) || price <= 0) continue;

    let rest = line.slice(0, priceMatch.index).trim();

    let quantity = 1;
    const qtyStartMatch = rest.match(QTY_AT_START);
    const qtyAnywhereMatch = rest.match(QTY_X_ANYWHERE);
    if (qtyStartMatch) {
      quantity = parseInt(qtyStartMatch[1], 10);
      rest = rest.slice(qtyStartMatch[0].length).trim();
    } else if (qtyAnywhereMatch) {
      quantity = parseInt(qtyAnywhereMatch[1], 10);
      rest = rest.replace(qtyAnywhereMatch[0], '').trim();
    }

    // Clean up a stray second trailing number some layouts leave behind
    // (e.g. unit price before the line total), plus any leftover "x"/"*"
    // multiplier symbol in front of it.
    rest = rest.replace(/\s+(?:x|X|\*)?\s*\d{1,6}(?:[.,]\d{2})\s*$/, '').trim();
    rest = rest.replace(/[.\-*]{2,}$/, '').trim(); // trailing dot-leaders "....."

    const name = rest.replace(/\s{2,}/g, ' ').trim();
    if (!name || name.length < 2 || !quantity || quantity <= 0) continue;

    items.push({ name, quantity, price });
  }

  return items;
}

// `source` can be a local file path (string) or an in-memory Buffer —
// Tesseract.js accepts either directly. Buffers are what storage.js hands
// us in S3 mode, so OCR never needs to touch local disk.
async function runOcr(source) {
  const options = {};
  if (process.env.TESSDATA_PATH) {
    options.langPath = process.env.TESSDATA_PATH;
    options.gzip = false;
  }

  const { data } = await Tesseract.recognize(source, 'eng', options);
  const rawText = data.text || '';
  let items = parseReceiptText(rawText);

  // If nothing parsed (unusual layout, poor scan quality), fall back to a
  // single placeholder line so the receipt still shows up for manual
  // review/edit instead of silently vanishing.
  if (items.length === 0) {
    items = [{ name: 'Unrecognized item — edit before applying', quantity: 1, price: 0 }];
  }

  return { rawText, items };
}

module.exports = { runOcr, parseReceiptText };

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

// Common printed date formats: 12/31/2026, 31-12-2026, 2026-12-31,
// "Date: Dec 31, 2026", "31 Dec 2026". Best-effort — receipts vary too
// much for anything exhaustive, so this covers the formats that show up
// most often rather than every locale's convention.
const DATE_PATTERNS = [
  /\b(\d{4}-\d{2}-\d{2})\b/,
  /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,
  /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/i,
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{2,4})\b/i,
];

/**
 * Best-effort extraction of a printed date from the receipt, if any —
 * used as the suggested arrival/invoice date rather than defaulting
 * silently to "whenever this got scanned", which can be a day or more
 * after goods actually arrived if a receipt sits in a pile before review.
 * Returns an ISO date string, or null if nothing parseable was found.
 */
function extractDocumentDate(rawText) {
  for (const line of rawText.split('\n')) {
    for (const pattern of DATE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const parsed = new Date(match[1]);
      if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 2000 && parsed.getFullYear() < 2100) {
        return parsed.toISOString().slice(0, 10);
      }
    }
  }
  return null;
}

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

async function runOcr(filePath) {
  const options = {};
  if (process.env.TESSDATA_PATH) {
    options.langPath = process.env.TESSDATA_PATH;
    options.gzip = false;
  }

  const { data } = await Tesseract.recognize(filePath, 'eng', options);
  const rawText = data.text || '';
  let items = parseReceiptText(rawText);
  const documentDate = extractDocumentDate(rawText);

  // If nothing parsed (unusual layout, poor scan quality), fall back to a
  // single placeholder line so the receipt still shows up for manual
  // review/edit instead of silently vanishing.
  if (items.length === 0) {
    items = [{ name: 'Unrecognized item — edit before applying', quantity: 1, price: 0 }];
  }

  return { rawText, items, documentDate };
}

module.exports = { runOcr, parseReceiptText, extractDocumentDate };

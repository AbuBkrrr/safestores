// ------------------------------------------------------------
// Auto-arrangement for newly-arrived stock: when a brand-new product is
// created from a scanned receipt (see receiptsController.js's
// applyReceipt), it has no shelf location yet. Rather than leaving it
// blank — invisible stock nobody knows where to find — this assigns one:
//
//  1. If the product has a category and other products in that category
//     already have a location, reuse whichever location is most common
//     among them (groups similar goods together, the way a real store
//     would want new soft drinks to land near the existing soft drinks).
//  2. Otherwise (no category, or a genuinely new category), round-robins
//     across a small set of default backroom bays based on how many
//     distinct locations already exist, so new stock spreads out instead
//     of piling into one place.
//
// This is a starting placement, not a final one — staff still move stock
// from backroom to shelf via the normal location field on the Products
// page; this just makes sure it's never sitting nowhere.
// ------------------------------------------------------------

const DEFAULT_BAYS = ['Backroom Bay A', 'Backroom Bay B', 'Backroom Bay C', 'Backroom Bay D', 'Backroom Bay E'];

function suggestLocation(db, storeId, category) {
  if (category) {
    const rows = db.prepare(
      `SELECT location, COUNT(*) AS n FROM products
       WHERE store_id = ? AND category = ? AND location IS NOT NULL AND location != ''
       GROUP BY location ORDER BY n DESC LIMIT 1`
    ).get(storeId, category);
    if (rows) return rows.location;
  }

  const distinctCount = db.prepare(
    `SELECT COUNT(DISTINCT location) AS n FROM products WHERE store_id = ? AND location IS NOT NULL AND location != ''`
  ).get(storeId).n;
  return DEFAULT_BAYS[distinctCount % DEFAULT_BAYS.length];
}

module.exports = { suggestLocation };

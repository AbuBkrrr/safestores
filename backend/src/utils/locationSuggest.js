// Web/Postgres counterpart to desktop/server/utils/locationSuggest.js —
// same logic, async/pg query style. See that file for the full rationale.

const DEFAULT_BAYS = ['Backroom Bay A', 'Backroom Bay B', 'Backroom Bay C', 'Backroom Bay D', 'Backroom Bay E'];

async function suggestLocation(client, storeId, category) {
  if (category) {
    const { rows } = await client.query(
      `SELECT location, COUNT(*) AS n FROM products
       WHERE store_id = $1 AND category = $2 AND location IS NOT NULL AND location != ''
       GROUP BY location ORDER BY n DESC LIMIT 1`,
      [storeId, category]
    );
    if (rows[0]) return rows[0].location;
  }

  const { rows: countRows } = await client.query(
    `SELECT COUNT(DISTINCT location) AS n FROM products WHERE store_id = $1 AND location IS NOT NULL AND location != ''`,
    [storeId]
  );
  return DEFAULT_BAYS[Number(countRows[0].n) % DEFAULT_BAYS.length];
}

module.exports = { suggestLocation };

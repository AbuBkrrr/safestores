const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { roundQty } = require('../utils/qty');
const { emitToStore } = require('../realtime');

// Production: recipes (ice-cream, bread: ingredients → product) and
// break-downs (abattoir, butchery: animal/carcass → cuts, with yield).

/** Stores running the store-room flow keep made goods in the store room; others put them straight on the shelf. */
async function outputsToStoreRoom(q, storeId) {
  return (await q.query(
    `SELECT 1 FROM users WHERE store_id = $1 AND role IN ('store_manager', 'shelf_manager') AND status = 'active' LIMIT 1`, [storeId]
  )).rowCount > 0;
}

/** Takes `qty` of a product out of stock: store room first, then the shelf. */
async function consume(client, storeId, productId, qty, note, userId) {
  const p = (await client.query('SELECT name, unit, backroom_qty, shelf_qty FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE', [productId, storeId])).rows[0];
  if (!p) return { error: 'Product not found' };
  const have = Number(p.backroom_qty) + Number(p.shelf_qty);
  if (qty > have + 0.0005) return { error: `Not enough ${p.name}: need ${qty} ${p.unit || ''}, have ${roundQty(have)}` };
  const fromBack = roundQty(Math.min(Number(p.backroom_qty), qty));
  const fromShelf = roundQty(qty - fromBack);
  if (fromBack > 0) await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'production_use',$3,$4,$5)`, [storeId, productId, fromBack, note, userId]);
  if (fromShelf > 0) await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'production_use_shelf',$3,$4,$5)`, [storeId, productId, fromShelf, note, userId]);
  await recomputeProductQuantities(client, productId);
  return { ok: true };
}

// GET /api/stores/:storeId/production/recipes
async function listRecipes(req, res) {
  const { rows } = await db.query(
    `SELECT r.*, COALESCE(json_agg(json_build_object('product_id', l.product_id, 'name', p.name, 'unit', p.unit, 'role', l.role, 'quantity', l.quantity,
              'in_stock', p.backroom_qty + p.shelf_qty, 'cost_price', p.cost_price) ORDER BY l.role, p.name) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
     FROM production_recipes r LEFT JOIN production_recipe_lines l ON l.recipe_id = r.id LEFT JOIN products p ON p.id = l.product_id
     WHERE r.store_id = $1 AND r.active GROUP BY r.id ORDER BY r.name`, [req.params.storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/production/recipes  { name, kind, notes?, lines: [{ productId, role, quantity }] }
async function saveRecipe(req, res) {
  const { storeId } = req.params;
  const { name, kind = 'recipe', notes } = req.body || {};
  const lines = (req.body?.lines || []).map((l) => ({ productId: l.productId, role: l.role, quantity: roundQty(l.quantity) }))
    .filter((l) => l.productId && ['input', 'output'].includes(l.role) && l.quantity > 0);
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Give the recipe a name' });
  if (!['recipe', 'breakdown'].includes(kind)) return res.status(400).json({ error: 'kind must be recipe or breakdown' });
  if (!lines.some((l) => l.role === 'input') || !lines.some((l) => l.role === 'output')) {
    return res.status(400).json({ error: 'Add at least one input (what goes in) and one output (what comes out)' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [...new Set(lines.map((l) => l.productId))];
    const ok = await client.query('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND id = ANY($2::uuid[])', [storeId, ids]);
    if (ok.rows[0].n !== ids.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A product in this recipe is not in your store' }); }
    const r = (await client.query(
      `INSERT INTO production_recipes (store_id, name, kind, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [storeId, String(name).trim().slice(0, 160), kind, notes ? String(notes).slice(0, 500) : null]
    )).rows[0];
    for (const l of lines) {
      await client.query('INSERT INTO production_recipe_lines (recipe_id, product_id, role, quantity) VALUES ($1,$2,$3,$4)', [r.id, l.productId, l.role, l.quantity]);
    }
    await client.query('COMMIT');
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not save the recipe' });
  } finally {
    client.release();
  }
}

// DELETE /api/stores/:storeId/production/recipes/:id  (archive)
async function archiveRecipe(req, res) {
  const { rowCount } = await db.query('UPDATE production_recipes SET active = false WHERE id = $1 AND store_id = $2', [req.params.id, req.params.storeId]);
  if (!rowCount) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ ok: true });
}

// POST /api/stores/:storeId/production/runs
//   { recipeId, batches, outputs?: [{ productId, quantity }], note? }
// Recipe: inputs × batches are used; outputs × batches are made (or the actual amounts given).
// Break-down: the actual weights of each cut are entered; yield = actual ÷ expected.
async function runProduction(req, res) {
  const { storeId } = req.params;
  const batches = roundQty(req.body?.batches || 1);
  if (!(batches > 0)) return res.status(400).json({ error: 'Batches must be more than 0' });
  // A client-chosen id (the app's offline queue) makes a replay a no-op.
  const clientId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.body?.id || '')) ? req.body.id : null;
  if (clientId && (await db.query('SELECT 1 FROM production_runs WHERE id = $1 AND store_id = $2', [clientId, storeId])).rowCount) {
    return res.status(201).json({ id: clientId, alreadyRecorded: true });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const recipe = (await client.query('SELECT * FROM production_recipes WHERE id = $1 AND store_id = $2 AND active', [req.body?.recipeId, storeId])).rows[0];
    if (!recipe) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipe not found' }); }
    const lines = (await client.query(
      `SELECT l.*, p.name, p.cost_price, p.price_multiplier FROM production_recipe_lines l JOIN products p ON p.id = l.product_id WHERE l.recipe_id = $1`, [recipe.id]
    )).rows;
    const actual = new Map((req.body?.outputs || []).map((o) => [o.productId, roundQty(o.quantity)]));
    const note = `${recipe.kind === 'breakdown' ? 'Break-down' : 'Production'}: ${recipe.name}`;
    const run = (await client.query(
      `INSERT INTO production_runs (id, store_id, recipe_id, kind, batches, note, performed_by) VALUES (COALESCE($7::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6) RETURNING *`,
      [storeId, recipe.id, recipe.kind, batches, req.body?.note ? String(req.body.note).slice(0, 300) : null, req.user.sub || null, clientId]
    )).rows[0];

    let inputCost = 0;
    for (const l of lines.filter((x) => x.role === 'input')) {
      const qty = roundQty(Number(l.quantity) * batches);
      const r = await consume(client, storeId, l.product_id, qty, note, req.user.sub || null);
      if (r.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: r.error }); }
      inputCost += qty * Number(l.cost_price || 0);
      await client.query('INSERT INTO production_run_lines (run_id, product_id, role, expected_qty, quantity) VALUES ($1,$2,$3,$4,$4)', [run.id, l.product_id, 'input', qty]);
    }

    const toStoreRoom = await outputsToStoreRoom(client, storeId);
    const outputs = lines.filter((x) => x.role === 'output').map((l) => {
      const expected = roundQty(Number(l.quantity) * batches);
      return { ...l, expected, qty: actual.has(l.product_id) ? actual.get(l.product_id) : expected };
    });
    if (outputs.some((o) => !(o.qty >= 0))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Output amounts cannot be negative' }); }
    const totalOut = outputs.reduce((s, o) => s + o.qty, 0);
    if (!(totalOut > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter how much was produced' }); }
    // Share the inputs' cost out by what each output sells for (amount ×
    // current selling price), so a kilo of offal doesn't carry the same cost
    // as a kilo of fillet, and a hide counted in pieces gets a sensible cost.
    // If any output has no selling price yet, fall back to sharing by amount.
    const made = outputs.filter((o) => o.qty > 0);
    const priceOf = (o) => Number(o.cost_price || 0) * Number(o.price_multiplier || 0);
    const byValue = made.length > 1 && made.every((o) => priceOf(o) > 0);
    const weightOf = (o) => (byValue ? o.qty * priceOf(o) : o.qty);
    const totalWeight = made.reduce((s2, o) => s2 + weightOf(o), 0);
    for (const o of outputs) {
      await client.query('INSERT INTO production_run_lines (run_id, product_id, role, expected_qty, quantity) VALUES ($1,$2,$3,$4,$5)', [run.id, o.product_id, 'output', o.expected, o.qty]);
      if (o.qty > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [storeId, o.product_id, toStoreRoom ? 'production_output' : 'production_output_shelf', o.qty, note, req.user.sub || null]
        );
        if (inputCost > 0 && totalWeight > 0) {
          const unitCost = (inputCost * (weightOf(o) / totalWeight)) / o.qty;
          await client.query('UPDATE products SET cost_price = $1 WHERE id = $2', [Math.round(unitCost * 100) / 100, o.product_id]);
        }
        await recomputeProductQuantities(client, o.product_id);
      }
    }
    await client.query('UPDATE production_runs SET input_cost = $1 WHERE id = $2', [Math.round(inputCost * 100) / 100, run.id]);
    await client.query('COMMIT');
    emitToStore(storeId, 'product:updated', { productionRun: run.id });
    const yieldPct = outputs.reduce((s, o) => s + o.expected, 0) > 0 ? Math.round((totalOut / outputs.reduce((s, o) => s + o.expected, 0)) * 1000) / 10 : null;
    res.status(201).json({ id: run.id, inputCost: Math.round(inputCost * 100) / 100, yieldPct, outputs: outputs.map((o) => ({ productId: o.product_id, name: o.name, expected: o.expected, quantity: o.qty })) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record the production run' });
  } finally {
    client.release();
  }
}

// GET /api/stores/:storeId/production/runs
async function listRuns(req, res) {
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.batches, r.note, r.input_cost, r.created_at, rc.name AS recipe_name, u.name AS performed_by_name,
            COALESCE(json_agg(json_build_object('name', p.name, 'unit', p.unit, 'role', l.role, 'expected', l.expected_qty, 'quantity', l.quantity) ORDER BY l.role, p.name)
              FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
     FROM production_runs r LEFT JOIN production_recipes rc ON rc.id = r.recipe_id LEFT JOIN users u ON u.id = r.performed_by
     LEFT JOIN production_run_lines l ON l.run_id = r.id LEFT JOIN products p ON p.id = l.product_id
     WHERE r.store_id = $1 GROUP BY r.id, rc.name, u.name ORDER BY r.created_at DESC LIMIT 50`, [req.params.storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/waste — what was written off (spoiled, expired, damaged) and its cost
async function wasteSummary(req, res) {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.unit, SUM(m.quantity) AS quantity, SUM(m.quantity * p.cost_price) AS value
     FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.store_id = $1 AND m.type IN ('damage', 'expiry', 'return_damaged') AND m.created_at > now() - ($2 || ' days')::interval
     GROUP BY p.id ORDER BY value DESC`, [req.params.storeId, String(days)]
  );
  const fresh = await db.query(
    `SELECT p.id, p.name, p.unit, p.shelf_qty, p.backroom_qty, p.shelf_life_days, p.storage_type,
            (SELECT MIN(b.expiry_date) FROM batches b WHERE b.product_id = p.id AND b.expiry_date >= CURRENT_DATE) AS next_expiry
     FROM products p WHERE p.store_id = $1 AND p.archived_at IS NULL
       AND (p.shelf_life_days IS NOT NULL OR p.storage_type <> 'ambient') AND (p.shelf_qty + p.backroom_qty) > 0
     ORDER BY next_expiry NULLS LAST, p.name LIMIT 200`, [req.params.storeId]
  );
  res.json({ days, items: rows, totalValue: Math.round(rows.reduce((s, r) => s + Number(r.value || 0), 0) * 100) / 100, fresh: fresh.rows });
}

module.exports = { listRecipes, saveRecipe, archiveRecipe, runProduction, listRuns, wasteSummary, consume };

const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { roundQty } = require('../utils/qty');
const { emitToStore } = require('../realtime');

// Production offline: recipes (ice-cream, bread: ingredients → product) and
// break-downs (abattoir, butchery: animal → cuts, with yield). Same rules as
// backend/src/controllers/productionController.js.

const fail = (status, error) => Object.assign(new Error(error), { userError: { status, body: { error } } });

/** Stores running the store-room flow keep made goods in the store room; others put them straight on the shelf. */
function outputsToStoreRoom(storeId) {
  return !!db.prepare(`SELECT 1 FROM users WHERE store_id = ? AND role IN ('store_manager', 'shelf_manager') AND status = 'active' LIMIT 1`).get(storeId);
}

/** Takes `qty` of a product out of stock: store room first, then the shelf. Call inside a transaction. */
function consume(storeId, productId, qty, note, userId) {
  const p = db.prepare('SELECT name, unit, backroom_qty, shelf_qty FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!p) return { error: 'Product not found' };
  const have = Number(p.backroom_qty) + Number(p.shelf_qty);
  if (qty > have + 0.0005) return { error: `Not enough ${p.name}: need ${qty} ${p.unit || ''}, have ${roundQty(have)}` };
  const fromBack = roundQty(Math.min(Number(p.backroom_qty), qty));
  const fromShelf = roundQty(qty - fromBack);
  const mv = db.prepare('INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,?,?,?,?)');
  if (fromBack > 0) mv.run(crypto.randomUUID(), storeId, productId, 'production_use', fromBack, note, userId);
  if (fromShelf > 0) mv.run(crypto.randomUUID(), storeId, productId, 'production_use_shelf', fromShelf, note, userId);
  recomputeProductQuantities(db, productId);
  return { ok: true };
}

// GET /api/stores/:storeId/production/recipes
function listRecipes(req, res) {
  const recipes = db.prepare('SELECT * FROM production_recipes WHERE store_id = ? AND active = 1 ORDER BY name').all(req.params.storeId);
  const lines = db.prepare(
    `SELECT l.product_id, p.name, p.unit, l.role, l.quantity, p.backroom_qty + p.shelf_qty AS in_stock, p.cost_price
     FROM production_recipe_lines l JOIN products p ON p.id = l.product_id WHERE l.recipe_id = ? ORDER BY l.role, p.name`
  );
  res.json(recipes.map((r) => ({ ...r, active: !!r.active, lines: lines.all(r.id) })));
}

// POST /api/stores/:storeId/production/recipes  { name, kind, notes?, lines: [{ productId, role, quantity }] }
function saveRecipe(req, res) {
  const { storeId } = req.params;
  const { name, kind = 'recipe', notes } = req.body || {};
  const lines = (req.body?.lines || []).map((l) => ({ productId: l.productId, role: l.role, quantity: roundQty(l.quantity) }))
    .filter((l) => l.productId && ['input', 'output'].includes(l.role) && l.quantity > 0);
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Give the recipe a name' });
  if (!['recipe', 'breakdown'].includes(kind)) return res.status(400).json({ error: 'kind must be recipe or breakdown' });
  if (!lines.some((l) => l.role === 'input') || !lines.some((l) => l.role === 'output')) {
    return res.status(400).json({ error: 'Add at least one input (what goes in) and one output (what comes out)' });
  }
  const ids = [...new Set(lines.map((l) => l.productId))];
  const found = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND id IN (${ids.map(() => '?').join(',')})`).get(storeId, ...ids).n;
  if (found !== ids.length) return res.status(400).json({ error: 'A product in this recipe is not in your store' });
  const id = req.body?.id || crypto.randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO production_recipes (id, store_id, name, kind, notes) VALUES (?,?,?,?,?)')
      .run(id, storeId, String(name).trim().slice(0, 160), kind, notes ? String(notes).slice(0, 500) : null);
    const ins = db.prepare('INSERT INTO production_recipe_lines (id, recipe_id, product_id, role, quantity) VALUES (?,?,?,?,?)');
    for (const l of lines) ins.run(crypto.randomUUID(), id, l.productId, l.role, l.quantity);
  })();
  const r = db.prepare('SELECT * FROM production_recipes WHERE id = ?').get(id);
  res.status(201).json({ ...r, active: !!r.active });
}

// DELETE /api/stores/:storeId/production/recipes/:id  (archive)
function archiveRecipe(req, res) {
  const r = db.prepare('UPDATE production_recipes SET active = 0 WHERE id = ? AND store_id = ?').run(req.params.id, req.params.storeId);
  if (!r.changes) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ ok: true });
}

// POST /api/stores/:storeId/production/runs  { recipeId, batches, outputs?: [{ productId, quantity }], note? }
function runProduction(req, res) {
  const { storeId } = req.params;
  const batches = roundQty(req.body?.batches || 1);
  if (!(batches > 0)) return res.status(400).json({ error: 'Batches must be more than 0' });
  const userId = req.user.sub || null;
  if (req.body?.id && db.prepare('SELECT 1 FROM production_runs WHERE id = ? AND store_id = ?').get(req.body.id, storeId)) {
    return res.status(201).json({ id: req.body.id, alreadyRecorded: true });
  }
  try {
    const out = db.transaction(() => {
      const recipe = db.prepare('SELECT * FROM production_recipes WHERE id = ? AND store_id = ? AND active = 1').get(req.body?.recipeId, storeId);
      if (!recipe) throw fail(404, 'Recipe not found');
      const lines = db.prepare(
        `SELECT l.*, p.name, p.cost_price, p.price_multiplier FROM production_recipe_lines l JOIN products p ON p.id = l.product_id WHERE l.recipe_id = ?`
      ).all(recipe.id);
      const actual = new Map((req.body?.outputs || []).map((o) => [o.productId, roundQty(o.quantity)]));
      const note = `${recipe.kind === 'breakdown' ? 'Break-down' : 'Production'}: ${recipe.name}`;
      const runId = req.body?.id || crypto.randomUUID();
      db.prepare('INSERT INTO production_runs (id, store_id, recipe_id, kind, batches, note, performed_by) VALUES (?,?,?,?,?,?,?)')
        .run(runId, storeId, recipe.id, recipe.kind, batches, req.body?.note ? String(req.body.note).slice(0, 300) : null, userId);
      const runLine = db.prepare('INSERT INTO production_run_lines (id, run_id, product_id, role, expected_qty, quantity) VALUES (?,?,?,?,?,?)');

      let inputCost = 0;
      for (const l of lines.filter((x) => x.role === 'input')) {
        const qty = roundQty(Number(l.quantity) * batches);
        const r = consume(storeId, l.product_id, qty, note, userId);
        if (r.error) throw fail(400, r.error);
        inputCost += qty * Number(l.cost_price || 0);
        runLine.run(crypto.randomUUID(), runId, l.product_id, 'input', qty, qty);
      }

      const toStoreRoom = outputsToStoreRoom(storeId);
      const outputs = lines.filter((x) => x.role === 'output').map((l) => {
        const expected = roundQty(Number(l.quantity) * batches);
        return { ...l, expected, qty: actual.has(l.product_id) ? actual.get(l.product_id) : expected };
      });
      if (outputs.some((o) => !(o.qty >= 0))) throw fail(400, 'Output amounts cannot be negative');
      const totalOut = outputs.reduce((s, o) => s + o.qty, 0);
      if (!(totalOut > 0)) throw fail(400, 'Enter how much was produced');
      // Share the inputs' cost by what each output sells for; by amount if any has no price yet.
      const made = outputs.filter((o) => o.qty > 0);
      const priceOf = (o) => Number(o.cost_price || 0) * Number(o.price_multiplier || 0);
      const byValue = made.length > 1 && made.every((o) => priceOf(o) > 0);
      const weightOf = (o) => (byValue ? o.qty * priceOf(o) : o.qty);
      const totalWeight = made.reduce((s, o) => s + weightOf(o), 0);
      for (const o of outputs) {
        runLine.run(crypto.randomUUID(), runId, o.product_id, 'output', o.expected, o.qty);
        if (o.qty > 0) {
          db.prepare('INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,?,?,?,?)')
            .run(crypto.randomUUID(), storeId, o.product_id, toStoreRoom ? 'production_output' : 'production_output_shelf', o.qty, note, userId);
          if (inputCost > 0 && totalWeight > 0) {
            const unitCost = (inputCost * (weightOf(o) / totalWeight)) / o.qty;
            db.prepare(`UPDATE products SET cost_price = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Math.round(unitCost * 100) / 100, o.product_id);
          }
          recomputeProductQuantities(db, o.product_id);
        }
      }
      db.prepare('UPDATE production_runs SET input_cost = ? WHERE id = ?').run(Math.round(inputCost * 100) / 100, runId);
      const expectedTotal = outputs.reduce((s, o) => s + o.expected, 0);
      return {
        id: runId, inputCost: Math.round(inputCost * 100) / 100,
        yieldPct: expectedTotal > 0 ? Math.round((totalOut / expectedTotal) * 1000) / 10 : null,
        outputs: outputs.map((o) => ({ productId: o.product_id, name: o.name, expected: o.expected, quantity: o.qty })),
      };
    })();
    emitToStore(storeId, 'product:updated', { productionRun: out.id });
    res.status(201).json(out);
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not record the production run' });
  }
}

// GET /api/stores/:storeId/production/runs
function listRuns(req, res) {
  const runs = db.prepare(
    `SELECT r.id, r.kind, r.batches, r.note, r.input_cost, r.created_at, rc.name AS recipe_name, u.name AS performed_by_name
     FROM production_runs r LEFT JOIN production_recipes rc ON rc.id = r.recipe_id LEFT JOIN users u ON u.id = r.performed_by
     WHERE r.store_id = ? ORDER BY r.created_at DESC LIMIT 50`
  ).all(req.params.storeId);
  const lines = db.prepare(
    `SELECT p.name, p.unit, l.role, l.expected_qty AS expected, l.quantity FROM production_run_lines l JOIN products p ON p.id = l.product_id
     WHERE l.run_id = ? ORDER BY l.role, p.name`
  );
  res.json(runs.map((r) => ({ ...r, lines: lines.all(r.id) })));
}

// GET /api/stores/:storeId/waste — what was written off (spoiled, expired, damaged) and its cost
function wasteSummary(req, res) {
  const { storeId } = req.params;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const items = db.prepare(
    `SELECT p.id, p.name, p.unit, p.sold_by, SUM(m.quantity) AS quantity, SUM(m.quantity * p.cost_price) AS value
     FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.store_id = ? AND m.type IN ('damage', 'expiry', 'return_damaged') AND m.created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
     GROUP BY p.id ORDER BY value DESC`
  ).all(storeId, `-${days} days`);
  const fresh = db.prepare(
    `SELECT p.id, p.name, p.unit, p.sold_by, p.shelf_qty, p.backroom_qty, p.shelf_life_days, p.storage_type,
            (SELECT MIN(b.expiry_date) FROM batches b WHERE b.product_id = p.id AND b.expiry_date >= date('now')) AS next_expiry
     FROM products p WHERE p.store_id = ? AND p.archived_at IS NULL
       AND (p.shelf_life_days IS NOT NULL OR COALESCE(p.storage_type, 'ambient') <> 'ambient') AND (p.shelf_qty + p.backroom_qty) > 0
     ORDER BY next_expiry IS NULL, next_expiry, p.name LIMIT 200`
  ).all(storeId);
  res.json({ days, items, totalValue: Math.round(items.reduce((s, r) => s + Number(r.value || 0), 0) * 100) / 100, fresh });
}

module.exports = { listRecipes, saveRecipe, archiveRecipe, runProduction, listRuns, wasteSummary, consume };

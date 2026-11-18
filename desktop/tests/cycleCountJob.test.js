const crypto = require('crypto');
const db = require('../server/db');
const { createStore, createProduct } = require('./helpers/factories');
const { runCycleCountSweep } = require('../server/cycleCountJob');

describe('cycleCountJob: runCycleCountSweep', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('schedules a high-priority task for a high-value, never-counted product, and notifies admins', async () => {
    const store = await createStore();
    // value at stake = 100 * 100 = 10,000 >= HIGH_VALUE_THRESHOLD (5000), plus never-counted — both push it to 'high'
    await createProduct(store.id, { costPrice: 100, backroomQty: 100, shelfQty: 0 });

    runCycleCountSweep();

    const task = db.prepare(`SELECT * FROM cycle_count_tasks WHERE store_id = ?`).get(store.id);
    expect(task).toBeTruthy();
    expect(task.risk_tier).toBe('high');

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ? AND type = 'cycle_count_task'`).get(store.id);
    expect(notif).toBeTruthy();
  });

  it('does not schedule a low-value product with no history that was already checked recently', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { costPrice: 1, backroomQty: 1, shelfQty: 0 }); // trivial value
    db.prepare(`INSERT INTO cycle_counts (id, store_id, product_id, counted_qty, expected_qty, discrepancy) VALUES (?,?,?,1,1,0)`)
      .run(crypto.randomUUID(), store.id, product.id); // counted just now — recent

    runCycleCountSweep();

    const task = db.prepare(`SELECT * FROM cycle_count_tasks WHERE store_id = ?`).get(store.id);
    expect(task).toBeUndefined();
  });

  it('does not schedule a second task for a product that already has an open one', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { costPrice: 100, backroomQty: 100, shelfQty: 0 });
    db.prepare(`INSERT INTO cycle_count_tasks (id, store_id, product_id, risk_tier, due_date, status) VALUES (?,?,?,'high', date('now','+3 days'),'pending')`)
      .run(crypto.randomUUID(), store.id, product.id);

    runCycleCountSweep();

    const tasks = db.prepare(`SELECT * FROM cycle_count_tasks WHERE store_id = ?`).all(store.id);
    expect(tasks).toHaveLength(1); // the pre-existing one only
  });

  it('caps new tasks at 5 per store per day, prioritizing highest value first', async () => {
    const store = await createStore();
    for (let i = 0; i < 8; i++) {
      await createProduct(store.id, { costPrice: 100, backroomQty: 100, shelfQty: 0 });
    }

    runCycleCountSweep();

    const tasks = db.prepare(`SELECT * FROM cycle_count_tasks WHERE store_id = ?`).all(store.id);
    expect(tasks).toHaveLength(5);
  });

  it('flips a pending task past its due date to overdue', async () => {
    const store = await createStore();
    const product = await createProduct(store.id);
    const taskId = crypto.randomUUID();
    db.prepare(`INSERT INTO cycle_count_tasks (id, store_id, product_id, risk_tier, due_date, status) VALUES (?,?,?,'medium', date('now','-2 days'),'pending')`)
      .run(taskId, store.id, product.id);

    runCycleCountSweep();

    const task = db.prepare('SELECT status FROM cycle_count_tasks WHERE id = ?').get(taskId);
    expect(task.status).toBe('overdue');
  });

  it('dispatches a cycle_count.high_priority webhook when high-priority tasks are scheduled', async () => {
    const store = await createStore();
    await createProduct(store.id, { costPrice: 100, backroomQty: 100, shelfQty: 0 });
    db.prepare(
      `INSERT INTO webhooks (id, store_id, url, secret, events, active) VALUES (?,?,?,?,?,1)`
    ).run(crypto.randomUUID(), store.id, 'https://example.com/hook', 'secret', JSON.stringify(['cycle_count.high_priority']));

    runCycleCountSweep();
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

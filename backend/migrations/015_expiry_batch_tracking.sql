-- ============================================================
-- Expiry & Batch Tracking.
--
-- A batch row is created automatically whenever a stock arrival is
-- recorded WITH an expiry date (batch_number is optional — some deliveries
-- have one, some don't, and either way there's now something to track
-- expiry against). Arrivals with no expiry_date create no batch — they're
-- untracked stock, same as before this migration existed.
--
-- Remaining quantity per batch is NOT stored as a column here — it's
-- computed at read time in utils/batches.js by walking a product's
-- batches in expiry order (oldest-expiring first, i.e. FIFO) against that
-- product's total sale+damage+expiry movements. This keeps it consistent
-- with stockMath.js's whole philosophy: derived from the append-only
-- event log, not a separately-mutated counter, so it can't drift and
-- needs no changes at any existing movement call site.
-- ============================================================

ALTER TABLE stock_arrivals ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);

CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_number VARCHAR(100),
  expiry_date DATE NOT NULL,
  quantity_received INTEGER NOT NULL,
  -- One batch per arrival, and only ever created once per arrival even if
  -- the create-arrival request is replayed (offline sync) — see
  -- inventoryController.createArrival's wasNewInsert guard, backed by
  -- this UNIQUE constraint as a second line of defense.
  arrival_id UUID UNIQUE REFERENCES stock_arrivals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON batches(product_id, expiry_date ASC);
CREATE INDEX IF NOT EXISTS idx_batches_store ON batches(store_id);

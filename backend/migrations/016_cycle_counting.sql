-- ============================================================
-- Cycle Counting & Inventory Accuracy.
--
-- Deliberately separate from shelf_audits/audit_engagements — those model
-- a formal, engagement-gated, external-auditor process (see
-- routes/stores.js's requireActiveEngagement). Cycle counting is the
-- opposite: frequent, informal, staff-initiated spot-checks on individual
-- products, available any time with no engagement required. A cycle count
-- validates a product's TOTAL on-hand quantity (shelf + backroom combined)
-- rather than a specific physical location.
--
-- cycle_count_tasks is the schedule: which product should be spot-checked
-- next, and by when. Generated automatically (see
-- src/jobs/cycleCountJob.js) by ranking products by a simple risk score —
-- value at stake, recent discrepancy history, and how long since it was
-- last counted — and assigning higher-risk products a shorter recount
-- cadence. A small batch of new tasks is created per store per day
-- (never every product at once), which is what "automates count
-- scheduling" means in practice: a manageable daily list, not a flood.
--
-- cycle_counts is the actual count record (analogous to shelf_audits but
-- for this lighter-weight flow) — optionally linked back to the task it
-- fulfilled, but ad-hoc counts with no task at all are also allowed.
-- ============================================================

CREATE TABLE IF NOT EXISTS cycle_count_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  risk_tier VARCHAR(10) NOT NULL CHECK (risk_tier IN ('high', 'medium', 'low')),
  due_date DATE NOT NULL,
  status VARCHAR(15) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'overdue', 'skipped')),
  cycle_count_id UUID, -- set once completed; FK added below after cycle_counts exists
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cycle_tasks_store_status ON cycle_count_tasks(store_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_cycle_tasks_product ON cycle_count_tasks(product_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS cycle_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  task_id UUID REFERENCES cycle_count_tasks(id) ON DELETE SET NULL,
  counted_qty INTEGER NOT NULL,
  expected_qty INTEGER NOT NULL, -- shelf_qty + backroom_qty at the moment of counting
  discrepancy INTEGER NOT NULL,
  auto_adjusted BOOLEAN NOT NULL DEFAULT false,
  performed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_store ON cycle_counts(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_product ON cycle_counts(product_id, created_at DESC);

ALTER TABLE cycle_count_tasks ADD CONSTRAINT fk_cycle_tasks_count
  FOREIGN KEY (cycle_count_id) REFERENCES cycle_counts(id) ON DELETE SET NULL;

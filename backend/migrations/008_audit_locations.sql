-- ============================================================
-- Location-based stock audits.
--
-- Previously a shelf audit only recorded counted_qty vs. products.shelf_qty
-- with no sense of *where* the count happened. This adds the physical
-- location a count was taken at (floor/shelf/row for in-store shelving,
-- zone for backroom/warehouse bays), so a store owner can get a
-- comprehensive, location-organized audit that reconciles manual counts
-- against real received/sold/damaged activity since goods arrived.
-- ============================================================

ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS area VARCHAR(20) NOT NULL DEFAULT 'shelf'
  CHECK (area IN ('shelf', 'backroom', 'warehouse'));
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS floor_number TEXT;
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS shelf_number TEXT;
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS row_number TEXT;
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS zone TEXT;

CREATE INDEX IF NOT EXISTS idx_shelf_audits_area ON shelf_audits(store_id, area);

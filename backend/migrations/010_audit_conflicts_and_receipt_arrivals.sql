-- ============================================================
-- Multi-stocktaker conflict/recount workflow: when two different
-- stocktakers count the same product+location and disagree within a
-- short window, both counts get flagged and an amber notification goes
-- to the store's admin(s) and both stocktakers. One of them recounts in
-- person with the other and submits the agreed figure; the other(s)
-- explicitly accept it, at which point it resolves and syncs to the
-- admin. See desktop/server/controllers/inventoryController.js's
-- createAudit/listConflicts/acceptRecount for the mirrored SQLite logic
-- and the full rationale.
-- ============================================================

ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS area VARCHAR(20) NOT NULL DEFAULT 'shelf'
  CHECK (area IN ('shelf', 'backroom', 'warehouse'));
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS floor_number VARCHAR(50);
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS shelf_number VARCHAR(50);
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS row_number VARCHAR(50);
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS zone VARCHAR(100);
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
  CHECK (status IN ('confirmed', 'needs_recount', 'resolved'));
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS conflict_group_id UUID;
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id);
ALTER TABLE shelf_audits ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_shelf_audits_conflict ON shelf_audits(conflict_group_id);

CREATE TABLE IF NOT EXISTS audit_conflict_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_group_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conflict_group_id, user_id)
);

-- Store-level notifications — distinct from the Super Admin's billing
-- notifications table. 'amber' is the recount-needed alert; 'info' is
-- the resolution confirmation once a recount is accepted.
CREATE TABLE IF NOT EXISTS store_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'amber' CHECK (severity IN ('amber', 'info')),
  audience_role VARCHAR(20),
  user_id UUID REFERENCES users(id),
  conflict_group_id UUID,
  message TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_notifications_store ON store_notifications(store_id, status, created_at DESC);

-- Links a received arrival back to the scanned receipt/image it came
-- from, for the admin's record-keeping view.
ALTER TABLE stock_arrivals ADD COLUMN IF NOT EXISTS receipt_id UUID REFERENCES receipts(id) ON DELETE SET NULL;

-- ============================================================
-- Auditor marketplace.
--
-- Stock-taking is no longer a feature every store admin has standing
-- access to. Instead:
--   - The Super Admin activates "auditor" accounts (independent service
--     providers, not scoped to one store).
--   - A store admin requests an audit engagement any time via the
--     "Auditor" tab.
--   - An active auditor accepts the request, then invites their own
--     stock-takers scoped to that specific engagement.
--   - Shelf-audit access for a store is gated to whether it has an
--     active (accepted/in_progress) engagement — see requireActiveEngagement.
-- ============================================================

CREATE TABLE IF NOT EXISTS auditors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  activated_by UUID REFERENCES super_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_engagements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  auditor_id UUID REFERENCES auditors(id),
  status VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'accepted', 'in_progress', 'completed', 'cancelled')),
  requested_by UUID REFERENCES users(id),
  notes TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_audit_engagements_store ON audit_engagements(store_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_engagements_auditor ON audit_engagements(auditor_id, requested_at DESC);

-- Stock-takers invited by an auditor for a specific engagement reuse the
-- existing invites/users flow, just scoped to that engagement.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS audit_engagement_id UUID REFERENCES audit_engagements(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_engagement_id UUID REFERENCES audit_engagements(id);

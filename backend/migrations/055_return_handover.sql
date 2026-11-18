-- Returned goods: security receives them from the customer, then hands them
-- to the store manager, who receives them into the store room as customer
-- returns (kept apart from supplier deliveries). Damaged units are written off.
ALTER TABLE security_returns ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE security_returns ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE security_returns ADD COLUMN IF NOT EXISTS qty_resellable INTEGER;
ALTER TABLE security_returns ADD COLUMN IF NOT EXISTS qty_damaged INTEGER;
ALTER TABLE security_returns ADD COLUMN IF NOT EXISTS receive_note TEXT;
CREATE INDEX IF NOT EXISTS idx_security_returns_pending ON security_returns(store_id, received_at);

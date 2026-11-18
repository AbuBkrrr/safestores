-- Exit tally: the guard ticks each receipt line against the goods going out.
-- 'passed' = everything matched; 'mismatch' = guard flagged a difference (manager alerted).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exit_status VARCHAR(12) CHECK (exit_status IN ('passed', 'mismatch'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exit_note TEXT;

-- Returns confirmed at the security post. A cashier/manager can only refund
-- quantities that security has physically received back (when the store has
-- security staff).
CREATE TABLE IF NOT EXISTS security_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  note TEXT,
  checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_returns_item ON security_returns(order_item_id);

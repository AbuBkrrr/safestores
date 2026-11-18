-- Security post at the exit: scan a receipt's QR code, confirm it was paid,
-- and mark it as checked out so the same receipt can't walk goods out twice.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exit_checked_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exit_checked_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_exit_checked ON orders(store_id, exit_checked_at);

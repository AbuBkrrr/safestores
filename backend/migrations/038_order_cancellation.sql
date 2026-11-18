-- Store-side cancellation of storefront orders. An online-paid order that is
-- cancelled is marked refund_due: the store refunds the customer (it holds
-- the money) and the platform credits back its commission on the ledger.
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_payment_status_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_payment_status_check
  CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refund_due', 'refunded'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(300);

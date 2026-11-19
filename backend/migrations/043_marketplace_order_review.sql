-- Marketplace orders are reviewed before they are fulfilled:
--   placed → confirmed (pickup or delivery chosen)
--          → ready_for_pickup  (pickup)   → fulfilled when collected
--          → out_for_delivery  (delivery) → fulfilled when delivered
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_status_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_status_check
  CHECK (status IN ('placed', 'confirmed', 'ready_for_pickup', 'out_for_delivery', 'fulfilled', 'cancelled'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS fulfilment_method VARCHAR(10)
  CHECK (fulfilment_method IN ('pickup', 'delivery'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
-- What the customer sees on their tracking page (rider name, pickup time…).
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS status_note VARCHAR(300);

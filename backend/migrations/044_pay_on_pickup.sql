-- Shoppers choose how they get the order (delivery or pickup) and when they
-- pay: online now, or cash when it's delivered / collected ('on_pickup').
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_payment_method_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_payment_method_check
  CHECK (payment_method IN ('on_delivery', 'on_pickup', 'online'));

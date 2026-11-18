-- Records what loyalty discount actually applied to THIS order, at the
-- time it was placed — not just a reference back to the store's current
-- settings, which could change later and rewrite history if we relied
-- on it instead.
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS loyalty_discount_pct NUMERIC(5,2);

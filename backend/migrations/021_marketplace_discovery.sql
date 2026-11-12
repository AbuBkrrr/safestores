-- ============================================================
-- Marketplace discoverability. Customers need to find a store in the
-- first place (by category/location), not just shop one they already
-- have a direct link to — this is what makes "store of choice" and
-- "search by category, store, location" actually possible.
--
-- marketplace_enabled defaults true: any active store is discoverable
-- unless its admin explicitly opts out (a store that only wants in-person
-- trade, for instance).
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS category VARCHAR(60);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS marketplace_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_stores_marketplace ON stores(marketplace_enabled, category, city) WHERE subscription_status = 'active';

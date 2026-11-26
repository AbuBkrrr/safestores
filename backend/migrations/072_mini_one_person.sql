-- Mini stores: the owner alone, or up to 5 people in all.
UPDATE store_tiers SET max_users = 5 WHERE tier = 'mini' AND (max_users IS NULL OR max_users < 5);
-- Received stock goes straight onto the shelf (sellable at once) instead of
-- the store room. NULL = follow the store size (on for Mini, off otherwise).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS auto_shelf BOOLEAN;

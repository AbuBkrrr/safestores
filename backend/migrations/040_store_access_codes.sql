-- Every store gets its own access code, shown on Manage Stores → Connect.
-- issued_for_store ties a code to the one store it was created for, so it
-- can't be redeemed by a different store.
ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS issued_for_store UUID REFERENCES stores(id) ON DELETE CASCADE;

-- Deleting a store that once redeemed a code shouldn't be blocked by it.
ALTER TABLE access_codes DROP CONSTRAINT IF EXISTS access_codes_used_by_store_fkey;
ALTER TABLE access_codes ADD CONSTRAINT access_codes_used_by_store_fkey
  FOREIGN KEY (used_by_store) REFERENCES stores(id) ON DELETE SET NULL;

-- Backfill: a code for every existing store that has none yet.
INSERT INTO access_codes (code, intended_tier, status, used_by_store, issued_for_store, expires_at)
SELECT 'ACC-' || upper(substr(md5(random()::text || s.id::text), 1, 4)) || '-' || upper(substr(md5(random()::text || s.name), 1, 4)),
       COALESCE(s.requested_tier, s.store_tier),
       CASE WHEN s.subscription_status = 'pending' THEN 'active' ELSE 'used' END,
       CASE WHEN s.subscription_status = 'pending' THEN NULL ELSE s.id END,
       s.id,
       now() + interval '30 days'
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM access_codes a WHERE a.issued_for_store = s.id OR a.used_by_store = s.id);

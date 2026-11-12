-- The self-service signup form (Signup.jsx) asks the store owner to pick a
-- size ("Store Size") and its UI promises "A Super Admin will review your
-- store and can adjust your size category" — but until now that choice was
-- collected by the frontend, sent to POST /auth/store/signup, and silently
-- discarded: storeSignup() never persisted it anywhere, so `store_tier`
-- always fell back to its DEFAULT 'mini' regardless of what was requested,
-- and the Super Admin reviewing new stores in ManageStores had no signal at
-- all of what the owner actually asked for.
--
-- requested_tier is what they asked for at signup (informational only,
-- never enforced); store_tier remains the actual, Super-Admin-assigned
-- tier that determines real limits — see 002_store_tiers.sql. A store
-- created directly by a Super Admin (not via self-signup) has no request
-- to record, hence nullable with no default.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS requested_tier VARCHAR(20);
ALTER TABLE stores
  ADD CONSTRAINT stores_requested_tier_check
  CHECK (requested_tier IS NULL OR requested_tier IN ('mini', 'midi', 'mega'));

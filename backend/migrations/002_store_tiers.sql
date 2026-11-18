-- ============================================================
-- Store tiers — Super Admin assigns each store a size category,
-- which drives plan limits (max products/users) instead of the old
-- fixed "basic/pro/premium" plan picked at signup.
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_tier VARCHAR(20) NOT NULL DEFAULT 'mini';
-- mini | midi | mega — see CHECK constraint below

ALTER TABLE stores ADD CONSTRAINT stores_tier_check
  CHECK (store_tier IN ('mini', 'midi', 'mega'));

-- Tier-based limits, analogous to the old subscription_plans row but keyed
-- by tier instead of a chosen plan. Super Admin can tune these per
-- deployment (e.g. raise mega's max_products) without a code change.
CREATE TABLE IF NOT EXISTS store_tiers (
  tier VARCHAR(20) PRIMARY KEY CHECK (tier IN ('mini', 'midi', 'mega')),
  label VARCHAR(60) NOT NULL,
  max_products INTEGER, -- NULL = unlimited
  max_users INTEGER,    -- NULL = unlimited
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO store_tiers (tier, label, max_products, max_users) VALUES
  ('mini', 'Mini Store', 200, 5),
  ('midi', 'Midi Store', 2000, 20),
  ('mega', 'Mega Store', NULL, NULL)
ON CONFLICT (tier) DO NOTHING;

-- Access codes can optionally pre-assign a tier, applied when the code is
-- redeemed. The super admin can also just set the tier directly when
-- activating a pending store from Manage Stores — both paths converge on
-- `stores.store_tier`.
ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS intended_tier VARCHAR(20) CHECK (intended_tier IN ('mini','midi','mega'));
ALTER TABLE access_codes ALTER COLUMN plan_id DROP NOT NULL;

-- The old fixed-price plan_id is superseded by store_tier (size) +
-- billing_model (see 003_billing.sql) but is left in place rather than
-- dropped outright, so nothing currently referencing it breaks.
COMMENT ON COLUMN stores.plan_id IS 'Deprecated — superseded by store_tier + billing_model. Left nullable for backward compatibility.';
ALTER TABLE stores ALTER COLUMN plan_id DROP NOT NULL;

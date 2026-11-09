-- ============================================================
-- 037 — Bolt-style settlements between the platform and each store
--
-- For orders that come through the app (storefront / marketplace):
--   • ONLINE payment: Paystack settles the money straight to the store's
--     bank and deducts the platform's commission at source (plus, if the
--     store owes anything, a capped part of that debt — "netting").
--   • CASH / pay-on-delivery: the store collects everything, so it OWES
--     the platform the commission. That's added to the store's balance.
--   • If a store's balance goes over the platform's limit, its storefront
--     stops offering pay-on-delivery until the balance is settled (like a
--     ride-hailing driver losing cash rides). The store can pay its balance
--     online at any time, or the super admin records a bank transfer.
--
-- The platform never holds the store's money: it only ever receives its
-- own commission. In-store POS sales are not affected.
-- ============================================================

ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS marketplace_commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (marketplace_commission_pct >= 0 AND marketplace_commission_pct <= 50);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS cash_debt_limit NUMERIC(14,2) NOT NULL DEFAULT 0
  CHECK (cash_debt_limit >= 0);  -- 0 = no limit (pay-on-delivery is never switched off)
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS max_recovery_pct NUMERIC(5,2) NOT NULL DEFAULT 50
  CHECK (max_recovery_pct >= 0 AND max_recovery_pct <= 90);  -- most of an online order's store share that may go to clearing debt

ALTER TABLE stores ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2)
  CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 50));  -- NULL = platform default

-- What was agreed for each order at checkout time.
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(14,2);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS debt_recovery NUMERIC(14,2) NOT NULL DEFAULT 0;

-- The store's running balance with the platform: SUM(amount).
-- amount > 0 → the store owes the platform more; amount < 0 → owes less.
CREATE TABLE IF NOT EXISTS store_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL CHECK (type IN (
    'cash_commission',      -- pay-on-delivery order completed: commission now owed   (+)
    'online_commission',    -- online order: commission withheld at source            (0, for the statement)
    'debt_recovered',       -- part of the debt withheld from an online order          (−)
    'settlement_payment',   -- store paid its balance (online or recorded transfer)    (−)
    'adjustment'            -- super-admin correction, either sign
  )),
  amount NUMERIC(14,2) NOT NULL,
  order_total NUMERIC(14,2),
  commission NUMERIC(14,2),
  marketplace_order_id UUID REFERENCES marketplace_orders(id) ON DELETE SET NULL,
  reference VARCHAR(100),
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_ledger_store ON store_ledger(store_id, created_at DESC);
-- One commission entry per order and type, so a retried webhook/fulfil can't double-charge.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_store_ledger_order_type ON store_ledger(marketplace_order_id, type) WHERE marketplace_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_store_ledger_reference ON store_ledger(reference) WHERE reference IS NOT NULL AND type = 'settlement_payment';

CREATE TABLE IF NOT EXISTS store_settlement_payments (
  reference VARCHAR(100) PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3),
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

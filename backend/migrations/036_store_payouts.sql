-- ============================================================
-- 036 — Online payments that go straight to each store
--
-- Each store links its own bank account once; we register it as a
-- Paystack *subaccount*. When a shopper pays online on that store's
-- storefront, Paystack splits the payment at source and settles the
-- store's share directly to the store's bank account. The platform never
-- receives or holds shopper money (only an optional commission, if one is
-- configured, which Paystack deducts automatically).
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_provider VARCHAR(20);          -- 'paystack' (room for 'flutterwave' / 'stripe' later)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_subaccount_code VARCHAR(60);   -- e.g. ACCT_xxxxxxxx — not a secret
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_bank_code VARCHAR(20);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_bank_name VARCHAR(120);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_account_last4 VARCHAR(4);      -- only the last 4 digits are kept here
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_account_name VARCHAR(160);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payout_connected_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS online_payments_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS pay_on_delivery_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'on_delivery'
  CHECK (payment_method IN ('on_delivery', 'online'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100) UNIQUE;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS currency VARCHAR(3);

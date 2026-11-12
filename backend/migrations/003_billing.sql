-- ============================================================
-- Billing — two models per store, set by the Super Admin:
--   'daily_percentage': store owes rate_percent% of each day's total
--       transaction revenue, charged daily. If unpaid, a grace-period
--       warning is sent, then the store is locked out.
--   'custom': a manually negotiated arrangement (notes only here —
--       no automatic charge/lockout).
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS billing_model VARCHAR(20) NOT NULL DEFAULT 'daily_percentage'
  CHECK (billing_model IN ('daily_percentage', 'custom'));
ALTER TABLE stores ADD COLUMN IF NOT EXISTS daily_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 1.00;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS grace_period_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS custom_billing_notes TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
-- locked = true means the store's staff/admin app has stopped functioning
-- (REST requests other than billing/auth get rejected) until the day's
-- charge is paid. See requireActiveStore / requireNotLocked middleware.

CREATE TABLE IF NOT EXISTS billing_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  charge_date DATE NOT NULL,               -- the day this charge is FOR
  transaction_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  rate_percent NUMERIC(5,2) NOT NULL,
  amount_due NUMERIC(14,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'waived', 'overdue')),
  warning_sent_at TIMESTAMPTZ,             -- when the 5-minute warning notification went out
  locked_at TIMESTAMPTZ,                   -- when the store was actually locked for non-payment
  paid_at TIMESTAMPTZ,
  marked_paid_by UUID,                     -- super admin who confirmed payment (manual, until a payment gateway is wired in)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, charge_date)
);
CREATE INDEX IF NOT EXISTS idx_billing_charges_store ON billing_charges(store_id, charge_date DESC);

-- Buy now, pay later — backed by a guarantor (bank, cooperative society,
-- PFA, employer or other corporate body) that settles the customer's credit
-- purchases up to an approved limit.
CREATE TABLE IF NOT EXISTS credit_guarantors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (kind IN ('bank', 'cooperative', 'pfa', 'employer', 'other')),
  contact_name VARCHAR(120), email VARCHAR(160), phone VARCHAR(40),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credit_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  guarantor_id UUID NOT NULL REFERENCES credit_guarantors(id),
  member_ref VARCHAR(80) NOT NULL,          -- staff no., member no., RSA PIN, account no.
  requested_limit NUMERIC(14,2) NOT NULL,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, customer_id)
);
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_payment_method_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_payment_method_check
  CHECK (payment_method IN ('on_delivery', 'on_pickup', 'online', 'credit'));
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS credit_account_id UUID REFERENCES credit_accounts(id) ON DELETE SET NULL;

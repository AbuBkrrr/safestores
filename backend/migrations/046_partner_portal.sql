-- Partner portal: guarantors and couriers log in to serve stores.
CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('guarantor', 'courier')),
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(40),
  password_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_invites (
  token VARCHAR(64) PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('guarantor', 'courier')),
  guarantor_id UUID REFERENCES credit_guarantors(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  created_by UUID,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '14 days',
  accepted_at TIMESTAMPTZ
);

ALTER TABLE credit_guarantors ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS store_couriers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, partner_id)
);

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS courier_id UUID REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS courier_picked_at TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS guarantor_paid_ref VARCHAR(120);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS guarantor_paid_reported_at TIMESTAMPTZ;

ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS member_verified BOOLEAN;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS member_verified_at TIMESTAMPTZ;

-- ============================================================
-- Customer credit tracking ("owing book") — separate from the existing
-- `customers` table, which is for marketplace self-service shoppers
-- (they have a password and log in themselves). This is for in-person
-- regulars a cashier knows by name/phone, who never create an account —
-- the staff creates and manages the record on their behalf.
-- ============================================================
CREATE TABLE IF NOT EXISTS store_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_store_customers_store ON store_customers(store_id) WHERE archived_at IS NULL;

-- A running ledger, not just a single "balance" column — so every credit
-- sale and every repayment has its own auditable row (who recorded it,
-- when, against which order if any), and the balance is always a SUM
-- over real entries rather than a mutable counter that could drift out
-- of sync with reality.
CREATE TABLE IF NOT EXISTS customer_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_customer_id UUID NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('credit_sale', 'payment', 'adjustment')),
  -- credit_sale and a positive 'adjustment' INCREASE what the customer
  -- owes; 'payment' and a negative 'adjustment' DECREASE it.
  amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  note TEXT,
  recorded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger_entries(store_customer_id, created_at);

-- ============================================================
-- Storefront loyalty — "every Nth marketplace order gets a discount."
-- Deliberately simple (one rule per store, not a whole promotions
-- engine) — a store admin turns it on, sets N and the discount, done.
-- ============================================================
ALTER TABLE stores ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS loyalty_every_nth_order INTEGER NOT NULL DEFAULT 5 CHECK (loyalty_every_nth_order >= 2);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS loyalty_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (loyalty_discount_pct > 0 AND loyalty_discount_pct <= 100);

-- ============================================================
-- Lending / microfinance partner module.
--
-- What this IS: real plumbing for a bank/MFI/lending app to register as
-- a partner, a store to explicitly opt in to sharing data with a
-- specific partner, and a scoped API a partner can call to pull an
-- AGGREGATE financial summary (monthly revenue, order counts, months
-- active) for stores that consented — never raw per-transaction data,
-- and never anything for a store that hasn't opted in.
--
-- What this is NOT: an actual live integration with a real bank. No
-- lender is connected by default — a super admin has to manually
-- register each real partner after a real business relationship exists.
-- This ships the mechanism, not a relationship with any specific lender.
-- ============================================================
CREATE TABLE IF NOT EXISTS lending_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('bank', 'microfinance', 'lending_app', 'other')),
  contact_name VARCHAR(120),
  contact_email VARCHAR(160),
  contact_phone VARCHAR(40),
  -- Only a hash is stored, same pattern as webhooks.secret — the real
  -- API key is shown to the super admin once, at creation time, and
  -- never again.
  api_key_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_lending_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  lending_partner_id UUID NOT NULL REFERENCES lending_partners(id) ON DELETE CASCADE,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (store_id, lending_partner_id)
);
CREATE INDEX IF NOT EXISTS idx_lending_consents_active ON store_lending_consents(lending_partner_id) WHERE revoked_at IS NULL;

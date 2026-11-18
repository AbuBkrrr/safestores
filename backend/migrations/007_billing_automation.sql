-- ============================================================
-- Billing automation parity items (desktop port session):
--   - store-admin "I've Paid" claim on a billing_charges row
--   - a waive path alongside mark-paid
--   - notifications surfaced to the Super Admin (claims, warnings, lockouts)
--   - a single editable payment_settings row shown on every Billing screen
-- ============================================================

ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS claim_method VARCHAR(20);
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS claim_reference TEXT;
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ;
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS waived_by UUID;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(30) NOT NULL,               -- payment_claim | overdue_warning | store_locked
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  billing_charge_id UUID REFERENCES billing_charges(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  account_number TEXT,
  account_name TEXT,
  bank_or_provider TEXT,
  methods JSONB NOT NULL DEFAULT '[]',
  instructions TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payment_settings (id, account_number, account_name, bank_or_provider, methods, instructions)
VALUES ('default', '8032540215', 'SAFE Stores', 'OPAY',
        '["ussd","bank_transfer","cash","card"]',
        'Pay via USSD, bank transfer, cash, or card to the OPAY account above, then click "I''ve Paid" and enter your payment reference.')
ON CONFLICT (id) DO NOTHING;

-- Guarantor KYC before credit is approved:
--   1. customer uploads the guarantor declaration letter, signed and sealed by the guarantor;
--   2. customer pays the store's documentation (processing) fee;
--   3. store verifies the letter with the guarantor (in person, phone or email).
-- Only then can the account be approved.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS credit_processing_fee NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS letter_uploaded_at TIMESTAMPTZ;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(12,2);
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS fee_paid_at TIMESTAMPTZ;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS fee_reference VARCHAR(120);
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS fee_recorded_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS verify_method VARCHAR(20) CHECK (verify_method IN ('in_person', 'email', 'phone', 'portal'));
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS verify_contact VARCHAR(160);
ALTER TABLE credit_accounts ADD COLUMN IF NOT EXISTS verify_note TEXT;

-- The letter itself, kept privately (not in the public uploads folder).
CREATE TABLE IF NOT EXISTS credit_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
  doc_type VARCHAR(30) NOT NULL DEFAULT 'guarantor_letter',
  filename VARCHAR(200) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_documents_account ON credit_documents(account_id, created_at DESC);

-- Auditor KYC: applicants submit details + credential documents for Super Admin review.
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS company VARCHAR(160);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS id_type VARCHAR(40);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS id_number VARCHAR(60);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS professional_body VARCHAR(120);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS membership_number VARCHAR(60);
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS years_experience INTEGER;
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE auditors ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE auditors DROP CONSTRAINT IF EXISTS auditors_status_check;
ALTER TABLE auditors ADD CONSTRAINT auditors_status_check CHECK (status IN ('pending', 'active', 'suspended', 'rejected'));

-- Kept in the database (not the public /uploads folder): only the Super Admin can read them.
CREATE TABLE IF NOT EXISTS auditor_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auditor_id UUID NOT NULL REFERENCES auditors(id) ON DELETE CASCADE,
  doc_type VARCHAR(30) NOT NULL CHECK (doc_type IN ('id_document', 'certificate', 'business_reg', 'other')),
  filename VARCHAR(200) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditor_documents_auditor ON auditor_documents(auditor_id);

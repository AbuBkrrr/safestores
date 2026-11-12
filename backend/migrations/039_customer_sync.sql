-- Store customers sync between desktop and cloud: edits need a timestamp to
-- merge last-write-wins.
ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE store_customers SET updated_at = COALESCE(archived_at, created_at) WHERE updated_at IS NULL;
ALTER TABLE store_customers ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE store_customers ALTER COLUMN updated_at SET NOT NULL;

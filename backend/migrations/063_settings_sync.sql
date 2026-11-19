-- Store settings (business type, tax, receipt text, currency...) can be edited
-- on a shop computer or online. settings_updated_at changes only when the
-- settings themselves do, so sync can take the latest edit without a billing
-- or lock change elsewhere overwriting it.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS settings_updated_at TIMESTAMPTZ;

-- Cash taken for a tailoring/laundry job goes in the same drawer as till
-- sales, so it belongs to the shift of whoever took it.
ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_payments_shift ON job_payments(shift_id);

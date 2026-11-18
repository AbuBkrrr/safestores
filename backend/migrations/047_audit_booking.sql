-- Audits are booked by the store for a date/time; the Super Admin assigns an auditor.
ALTER TABLE audit_engagements ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE audit_engagements ADD COLUMN IF NOT EXISTS assigned_by UUID;
ALTER TABLE audit_engagements ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Repair statuses such as 'awaiting_approval' are longer than the original 12 characters.
ALTER TABLE job_orders ALTER COLUMN status TYPE VARCHAR(20);

-- Job titles that fit the business (Chef, Waiter, Technician, Front desk…),
-- each sitting on a permission role. Shown on invites, the staff list and
-- the person's own screen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(60);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS job_title VARCHAR(60);

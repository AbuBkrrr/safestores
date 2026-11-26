-- Messages from the website's contact form go into the Super Admin support
-- inbox too. They have no store yet, so the store is optional and the sender's
-- contact details are kept on the ticket.
ALTER TABLE support_tickets ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'store';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(40);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_email VARCHAR(160);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES marketing_leads(id) ON DELETE SET NULL;

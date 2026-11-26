-- Live support chat: a visitor (website or app) chats with Super Admin
-- support. Each chat is a support ticket with source 'chat', found by a
-- secret kept in the visitor's browser (only its hash is stored).
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS chat_token_hash CHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_chat ON support_tickets(chat_token_hash) WHERE chat_token_hash IS NOT NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS visitor_seen_at TIMESTAMPTZ;
ALTER TABLE support_ticket_replies DROP CONSTRAINT IF EXISTS support_ticket_replies_author_type_check;
ALTER TABLE support_ticket_replies ADD CONSTRAINT support_ticket_replies_author_type_check
  CHECK (author_type IN ('store_user', 'super_admin', 'visitor'));

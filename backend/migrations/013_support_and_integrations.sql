-- ============================================================
-- Support tickets + outbound webhooks ("integrations").
--
-- Replaces "support = email address" with a real in-app ticket system
-- (store admins/managers raise a ticket, Super Admin sees a shared queue
-- across every store and replies; both sides get an email if SMTP is
-- configured — see src/utils/mailer.js). Notifications table already
-- covers *in-app* alerts; this is for things that need a thread and a
-- resolution state.
--
-- Webhooks give any store a generic integration point — register a URL +
-- which events matter, get an HMAC-signed POST when they happen (receipt
-- applied, order paid, low stock, etc. — see src/utils/webhooks.js and its
-- call sites). This is the "connect anything" answer to "no integrations":
-- Zapier, a custom script, an accounting tool's inbound-webhook feature,
-- or bespoke in-house software can all subscribe without us building a
-- one-off integration per vendor.
-- ============================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_store ON support_tickets(store_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  -- No single FK target — a reply's author is either a store user or a
  -- super admin, two different tables. author_type disambiguates.
  author_type VARCHAR(15) NOT NULL CHECK (author_type IN ('store_user', 'super_admin')),
  author_id UUID,
  author_name VARCHAR(120) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_replies_ticket ON support_ticket_replies(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  -- HMAC-SHA256 signing secret, generated server-side and shown once at
  -- creation — see webhooksController.createWebhook.
  secret VARCHAR(100) NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',
    -- e.g. {'receipt.applied','order.paid','purchase_order.auto_created','support_ticket.replied'}
  active BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  last_status_code INTEGER,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhooks_store ON webhooks(store_id, active);

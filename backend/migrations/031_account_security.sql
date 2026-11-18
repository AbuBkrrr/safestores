-- ============================================================
-- 031 — Account security & accountability
--   * email verification, password reset (one-time hashed tokens)
--   * TOTP two-factor login (authenticator apps — RFC 6238, no SMS cost)
--   * token_version: bumping it revokes every outstanding JWT for that
--     account ("sign out everywhere", password change, password reset)
--   * activity_log: who did what (prices, refunds, discounts, users…)
--   * store deletion with a 30-day grace period (data-protection erasure)
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_kind VARCHAR(20) NOT NULL CHECK (account_kind IN ('user', 'super_admin')),
  account_id UUID NOT NULL,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
  token_hash TEXT NOT NULL UNIQUE,      -- sha256 of the emailed token; the token itself is never stored
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_account ON auth_tokens(account_kind, account_id, purpose);

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,   -- NULL = platform-level (super admin) action
  actor_id UUID,
  actor_role VARCHAR(30),
  actor_name VARCHAR(160),
  action VARCHAR(60) NOT NULL,          -- e.g. 'order.refunded', 'product.price_changed'
  entity_type VARCHAR(40),
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_store ON activity_log(store_id, created_at DESC);

ALTER TABLE stores ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ;

-- Existing admin accounts predate verification; treat them as verified so
-- nobody already using the system is suddenly nagged or blocked.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL AND password_hash IS NOT NULL;

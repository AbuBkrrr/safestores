-- ============================================================
-- Push notification device tokens (Android/iOS mobile edition).
--
-- Companion to backend/src/utils/push.js and mobile/'s @capacitor/push-
-- notifications wiring. A logged-in user's device registers its FCM token
-- here after granting notification permission (see routes/push.js); the
-- backend looks tokens up by user_id when it wants to push something —
-- see call sites in inventoryController.js (recount alerts),
-- marketplaceController.js (new order), and supportController.js
-- (ticket replies).
--
-- One user can have multiple tokens (phone + tablet, or a reinstalled
-- app that got a new token) — token itself is the unique key so a
-- re-registration from the same device just updates last_seen_at rather
-- than accumulating duplicates.
-- ============================================================

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE, -- redundant with users.store_id, kept for fast store-wide push queries
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(20) NOT NULL DEFAULT 'android', -- android | ios
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON device_push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_store ON device_push_tokens(store_id);

-- ============================================================
-- Desktop is the sole per-store runtime — a store's admin/manager has no
-- cloud user session at all, so the handful of store-facing cloud actions
-- that used to attribute themselves via req.user.sub (a cloud users.id)
-- can no longer do that; requested_by/created_by would either be null or,
-- worse, silently reference a desktop-local user id that happens to not
-- exist in this database's users table.
--
-- Fix: these actions are now sync_key-authenticated (device trust, like
-- sync/export+import already were), and desktop passes along a plain
-- display name instead of an identity the cloud can verify. requested_by/
-- created_by stay as-is (now always null for desktop-originated rows) —
-- nothing currently reads them expecting a value, so nothing else changes.
-- ============================================================

ALTER TABLE audit_engagements ADD COLUMN IF NOT EXISTS requested_by_name VARCHAR(120);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(120);

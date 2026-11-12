-- ============================================================
-- Webhooks need to sync across a store's devices like everything else —
-- a subscription set up on one register should show up on another, and a
-- deleted one should never get resurrected by a later sync pulling in an
-- older snapshot that doesn't know about the delete yet.
--
-- updated_at makes last-write-wins merging possible (same pattern as
-- products already use). deleted_at is a tombstone rather than a hard
-- delete — a delete just sets both timestamps to now(); whichever device's
-- copy has the latest updated_at wins outright, deleted_at included, so a
-- delete always propagates and never gets undone by an older sync.
-- ============================================================

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- The cloud no longer has its own webhook management UI (see the
-- desktop-only architecture decision) — this table now exists purely as a
-- sync relay/backup target for desktop's local webhooks, which store
-- `events` as a JSON string (SQLite has no native array type). Converting
-- this column to match means the sync merge in syncController.js can
-- treat the value as an opaque string on both sides instead of
-- reformatting between a Postgres array and JSON at the sync boundary.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS events_json TEXT;
UPDATE webhooks SET events_json = COALESCE(to_json(events)::text, '[]') WHERE events_json IS NULL;
ALTER TABLE webhooks ALTER COLUMN events_json SET NOT NULL;
ALTER TABLE webhooks DROP COLUMN IF EXISTS events;
ALTER TABLE webhooks RENAME COLUMN events_json TO events;

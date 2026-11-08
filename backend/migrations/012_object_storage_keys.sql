-- ============================================================
-- Object storage keys.
--
-- Companion to backend/src/utils/storage.js. `image_url`/`image_url`-style
-- columns already held a public URL; this adds the underlying storage key
-- (S3 object key, or local filename) so deleteUpload() knows exactly what
-- to remove without having to reverse-engineer it from the URL.
-- Existing rows get a NULL storage_key (pre-migration uploads on local
-- disk) — deleteUpload() no-ops safely on a NULL/empty key.
-- ============================================================

ALTER TABLE images ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS storage_key TEXT;

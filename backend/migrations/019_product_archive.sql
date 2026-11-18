-- ============================================================
-- Products are never hard-deleted — see desktop/server/schema.sqlite.sql's
-- comment on this same column for the full reasoning: stock_arrivals/
-- stock_movements/shelf_audits/batches (and, as of migration 016,
-- cycle-count tables) all ON DELETE CASCADE off product_id, so a real
-- delete would silently wipe that product's entire history along with it.
-- This column exists here purely so a synced-in archived_at value from a
-- desktop install has somewhere to land — this cloud database has no live
-- product-management routes of its own anymore (see the desktop-only
-- architecture decision), it's a sync/backup target only.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

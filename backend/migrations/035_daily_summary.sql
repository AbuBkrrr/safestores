-- ============================================================
-- 035 — End-of-day summary email
-- At 21:00 in each store's own time zone, admins get a short email:
-- today's sales, refunds, top items, low stock. On by default; admins
-- can turn it off in Store Settings. Needs SMTP configured to send.
-- ============================================================
ALTER TABLE stores ADD COLUMN IF NOT EXISTS daily_summary_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS last_summary_on DATE;

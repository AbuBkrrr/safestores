-- ============================================================
-- Perishable goods: storage type.
--
-- Expiry & Batch Tracking (015_expiry_batch_tracking.sql) already tracks a
-- specific expiry date per batch, but its alert/markdown logic assumed
-- shelf-stable packaged goods — a 14-day alert window and 3/7/14/30-day
-- discount bands. That's far too slow for genuinely perishable goods:
-- fresh dairy, produce, and especially ice cream/frozen items can go from
-- fine to a write-off in a matter of days, sometimes hours, not weeks.
--
-- storage_type lets a product opt into a much tighter urgency curve (see
-- utils/batches.js's suggestedDiscountPct and expiryJob.js's alert
-- severity) without changing anything about how shelf-stable goods are
-- handled — default 'ambient' preserves today's behavior exactly for
-- every existing product.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_type VARCHAR(20) NOT NULL DEFAULT 'ambient'
  CHECK (storage_type IN ('ambient', 'refrigerated', 'frozen'));
CREATE INDEX IF NOT EXISTS idx_products_storage_type ON products(store_id, storage_type) WHERE storage_type != 'ambient';

-- ============================================================
-- Unified cross-store marketplace, take 2, based on clarified requirements:
--   - One marketplace site lists products from every subscribed store
--     together (not per-store separate shops) — see routes/marketplace.js's
--     listStores/searchProducts.
--   - Search needs to work by brand too, not just name/category.
--   - Each listing needs an image — a captured product photo if the store
--     has one, otherwise the frontend falls back to a generic
--     category-based placeholder (no schema needed for the fallback case,
--     only for the "has a real photo" case).
--   - Checkout must work WITHOUT an account — see marketplace_orders'
--     customer_id becoming nullable plus guest_name/email/phone below.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(100);
-- A product's single representative marketplace image — set by picking
-- from the store's own captured photos (images table) or uploading one
-- directly. Deliberately just a URL, not a FK to `images`, since the
-- source photo might later be deleted from the gallery without that
-- needing to also blank out an already-chosen marketplace listing image.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Guest checkout: an order needs EITHER a real customer account OR guest
-- contact details, never neither.
ALTER TABLE marketplace_orders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS guest_name VARCHAR(120);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS guest_email VARCHAR(160);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(40);
ALTER TABLE marketplace_orders ADD CONSTRAINT chk_marketplace_orders_has_identity
  CHECK (customer_id IS NOT NULL OR guest_name IS NOT NULL);

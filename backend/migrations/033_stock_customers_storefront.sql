-- ============================================================
-- 033 — Stock, customers & storefront upgrades
--   * product barcodes (separate from SKU), pack sizes (carton → units),
--     simple variants (a product can be a size/colour of another)
--   * branch-to-branch stock transfers (stores sharing an owner)
--   * customer email/birthday + loyalty points ledger with expiry
--   * marketplace order tracking links
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_size INTEGER NOT NULL DEFAULT 1 CHECK (pack_size >= 1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_unit VARCHAR(30);          -- e.g. 'carton', 'crate'
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_of UUID REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_label VARCHAR(80);      -- e.g. 'Large / Red'
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(store_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  to_store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received', 'cancelled')),
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  CHECK (from_store_id <> to_store_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON stock_transfers(from_store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON stock_transfers(to_store_id, created_at DESC);
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  from_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  to_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  sku VARCHAR(60) NOT NULL,
  name VARCHAR(200) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12,2)
);

ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS email VARCHAR(160);
ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS birthday DATE;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS points_per_100 NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (points_per_100 >= 0); -- 0 = points off
ALTER TABLE stores ADD COLUMN IF NOT EXISTS point_value NUMERIC(10,4) NOT NULL DEFAULT 1 CHECK (point_value >= 0);      -- currency per point
ALTER TABLE stores ADD COLUMN IF NOT EXISTS points_expiry_months INTEGER NOT NULL DEFAULT 12 CHECK (points_expiry_months >= 0); -- 0 = never

CREATE TABLE IF NOT EXISTS loyalty_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_customer_id UUID NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
  points INTEGER NOT NULL CHECK (points <> 0),   -- + earned, − redeemed
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  reason VARCHAR(40) NOT NULL DEFAULT 'sale',
  expires_at TIMESTAMPTZ,                         -- earned points only
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_points_customer ON loyalty_points(store_customer_id, created_at);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(40) UNIQUE;
UPDATE marketplace_orders SET tracking_token = replace(gen_random_uuid()::text, '-', '') WHERE tracking_token IS NULL;

-- Camera recognition of products with no barcode: small picture
-- fingerprints ("looks") per product, taught by the shop's own photos and
-- by every item the cashier confirms from a camera picture.
CREATE TABLE IF NOT EXISTS product_looks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sig TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_looks_store ON product_looks(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_product_looks_product ON product_looks(product_id, created_at);

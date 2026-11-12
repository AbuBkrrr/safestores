-- ============================================================
-- Smart Replenishment System.
--
-- Reorder points are no longer a single static number an admin sets once
-- (products.reorder_level, kept for backward compat / manual override) —
-- they're computed from actual sales velocity out of stock_movements
-- (type = 'sale'), the product's lead time, and a simple trend check
-- against the prior period so a seasonal ramp-up nudges the point up
-- before the store actually runs out. See backend/src/utils/replenishment.js
-- for the calculation and backend/src/controllers/replenishmentController.js
-- for how it's surfaced/turned into purchase orders.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty INTEGER NOT NULL DEFAULT 1;
-- Off by default: a product only gets swept into an auto-generated draft PO
-- once an admin has explicitly marked its supplier as trusted for that —
-- this is the "approved suppliers" gate from the feature's spec. Every
-- product still shows up in suggestions either way; this only controls
-- whether a DRAFT purchase order gets created for it automatically.
ALTER TABLE products ADD COLUMN IF NOT EXISTS auto_reorder BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- Free-text, matching products.supplier — this app doesn't have a
  -- normalized suppliers table yet (that's the Supplier Performance
  -- Analytics feature); a PO groups whichever products share this string.
  supplier VARCHAR(150) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  auto_generated BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  received_by UUID REFERENCES users(id),
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_store ON purchase_orders(store_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  received_quantity INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(purchase_order_id);

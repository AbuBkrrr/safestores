-- ============================================================
-- Supplier Performance Analytics.
--
-- Until now `products.supplier` and `purchase_orders.supplier` were both
-- free text (see the comment in 011_smart_replenishment.sql) — fine for
-- grouping auto-generated POs, but there was nothing to track reliability
-- or compare pricing against. This adds a real `suppliers` table and
-- backfills it from whatever text values already exist, so nothing
-- currently in use breaks.
--
-- `products.supplier` and `purchase_orders.supplier` (the text columns)
-- are kept as-is for backward compatibility and as a display fallback —
-- the new `supplier_id` columns are populated alongside them going
-- forward (see src/utils/supplierLookup.js) and are what performance/
-- pricing analytics actually query against.
-- ============================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  contact_name VARCHAR(120),
  phone VARCHAR(40),
  email VARCHAR(160),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, name)
);
CREATE INDEX IF NOT EXISTS idx_suppliers_store ON suppliers(store_id);

-- Backfill one supplier row per distinct name already in use, from either
-- source column, per store.
INSERT INTO suppliers (store_id, name)
SELECT DISTINCT store_id, supplier FROM products
WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
ON CONFLICT (store_id, name) DO NOTHING;

INSERT INTO suppliers (store_id, name)
SELECT DISTINCT store_id, supplier FROM purchase_orders
WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
ON CONFLICT (store_id, name) DO NOTHING;

ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
UPDATE products p SET supplier_id = s.id
  FROM suppliers s
  WHERE s.store_id = p.store_id AND s.name = p.supplier AND p.supplier_id IS NULL;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
UPDATE purchase_orders po SET supplier_id = s.id
  FROM suppliers s
  WHERE s.store_id = po.store_id AND s.name = po.supplier AND po.supplier_id IS NULL;

-- Expected delivery date, set when a PO is sent (sent_at + that order's
-- average product lead time) — compared against received_at to compute
-- on-time-delivery performance. NULL for POs sent before this migration;
-- those are simply excluded from on-time-rate math, not counted against
-- the supplier.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_at TIMESTAMPTZ;

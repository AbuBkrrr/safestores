-- ============================================================
-- 032 — Till upgrades
--   * per-store currency, time zone, tax, receipt text (global use)
--   * order discounts (with manager approval above a store limit)
--   * tax (inclusive or exclusive) computed on every order
--   * split payments (order_payments), change due
--   * refunds/returns with optional restock ('return' stock movement)
--   * cashier shifts with opening float and counted-cash close (Z-report)
--   * parked sales (label on a pending order)
--   * shareable digital receipts (public_token)
-- ============================================================

-- Per-store settings. NULL currency = fall back to the platform default
-- in currency_settings, so existing stores look exactly as before.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(8);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'UTC';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_rate_pct NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_label VARCHAR(20) NOT NULL DEFAULT 'VAT';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_number VARCHAR(60);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_header TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_footer TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS max_cashier_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (max_cashier_discount_pct >= 0 AND max_cashier_discount_pct <= 100);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS require_shift BOOLEAN NOT NULL DEFAULT false;
-- The app was launched in Nigeria; existing stores keep Lagos time so
-- their "today" doesn't shift by an hour. New stores pick their own.
UPDATE stores SET timezone = 'Africa/Lagos' WHERE timezone = 'UTC';

CREATE TABLE IF NOT EXISTS shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_float NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  expected_cash NUMERIC(14,2),
  counted_cash NUMERIC(14,2),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_store ON shifts(store_id, opened_at DESC);
-- One open shift per person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_shift_per_user ON shifts(opened_by) WHERE status = 'open';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) CHECK (discount_type IN ('percent', 'amount'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate_pct NUMERIC(6,3) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_tendered NUMERIC(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS change_due NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parked_label VARCHAR(80);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_customer_id UUID REFERENCES store_customers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_token VARCHAR(40) UNIQUE;
CREATE INDEX IF NOT EXISTS idx_orders_store_paid ON orders(store_id, paid_at DESC) WHERE status = 'paid';

CREATE TABLE IF NOT EXISTS order_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'mobile_money', 'credit', 'other')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),   -- amount APPLIED to the order (cash change excluded)
  reference VARCHAR(120),
  shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_shift ON order_payments(shift_id);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'mobile_money', 'credit', 'other')),
  reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_store ON refunds(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refund_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id UUID NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount NUMERIC(14,2) NOT NULL,
  restocked BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_refund_items_item ON refund_items(order_item_id);

-- ============================================================
-- POS checkout/cashier module.
--
-- 'checkout_mode' on stores lets each store choose:
--   'split'  — a checkout user scans/searches/photographs items to build
--              a pending order (an invoice awaiting payment), and a
--              separate cashier user confirms payment and issues the
--              receipt.
--   'merged' — one role (cashier) does both: builds the order AND takes
--              payment.
--
-- Adding an item to an order deducts stock immediately (a normal 'sale'
-- stock_movements row — reuses the existing event-sourced quantity model),
-- since the item is being physically handed over/reserved for purchase at
-- that point. Cancelling an unpaid order reverses that with an
-- 'adjustment' movement.
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS checkout_mode VARCHAR(20) NOT NULL DEFAULT 'merged'
  CHECK (checkout_mode IN ('split', 'merged'));

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'cancelled')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),   -- the checkout/cashier user who built the order
  paid_by UUID REFERENCES users(id),      -- the cashier who confirmed payment (same user if merged mode)
  payment_method VARCHAR(30),             -- cash | card | transfer | other — free text set at payment time
  receipt_number VARCHAR(40) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  line_total NUMERIC(14,2) NOT NULL,
  added_via VARCHAR(20) NOT NULL DEFAULT 'scan'
    CHECK (added_via IN ('scan', 'manual_search', 'photo')),
  movement_id UUID REFERENCES stock_movements(id), -- the deducting movement this line created
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

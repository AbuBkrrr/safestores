-- Chain of custody inside the store:
--   store manager receives deliveries into the store room (stock arrivals),
--   then hands stock over to the shelves; the shelf manager confirms what
--   actually reached the shelf. Stock only moves store room → shelf on that
--   confirmation, and any shortfall is flagged.
CREATE TABLE IF NOT EXISTS stock_handovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'received', 'short', 'cancelled')),
  note TEXT,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  receive_note TEXT
);
CREATE TABLE IF NOT EXISTS stock_handover_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id UUID NOT NULL REFERENCES stock_handovers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_issued INTEGER NOT NULL CHECK (qty_issued > 0),
  qty_received INTEGER CHECK (qty_received >= 0)
);
CREATE INDEX IF NOT EXISTS idx_stock_handovers_store ON stock_handovers(store_id, status, issued_at DESC);

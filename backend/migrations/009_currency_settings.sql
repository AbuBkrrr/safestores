-- ============================================================
-- Multi-currency display setting — a single Super-Admin-editable row
-- controlling which currency symbol/code is shown across the whole app
-- (store screens, receipts, and the public storefront). This is a display
-- setting only: switching it doesn't convert historical amounts, since
-- amounts are stored as plain numbers with no currency tagging per row.
-- ============================================================

CREATE TABLE IF NOT EXISTS currency_settings (
  id VARCHAR(10) PRIMARY KEY DEFAULT 'default',
  code VARCHAR(3) NOT NULL DEFAULT 'NGN',
  symbol VARCHAR(6) NOT NULL DEFAULT '₦',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO currency_settings (id, code, symbol) VALUES ('default', 'NGN', '₦')
  ON CONFLICT (id) DO NOTHING;

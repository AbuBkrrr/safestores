-- Shoppers can pay a store by bank transfer to the store's own account
-- (no payment gateway needed). The store confirms the money arrived.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS transfer_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS transfer_bank_name VARCHAR(120);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS transfer_account_number VARCHAR(40);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS transfer_account_name VARCHAR(160);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS transfer_note VARCHAR(300);
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_payment_method_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_payment_method_check
  CHECK (payment_method IN ('on_delivery', 'on_pickup', 'online', 'credit', 'transfer'));

-- A shopper paying by bank transfer taps "I've sent the payment" on the
-- tracking page; the store is alerted and confirms when the money arrives.
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS transfer_sent_at TIMESTAMPTZ;

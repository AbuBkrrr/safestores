-- Chat about an order straight from its tracking page (with a photo, e.g. the
-- transfer receipt). It is a customer message thread tied to the order.
ALTER TABLE store_inquiries ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES marketplace_orders(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inquiries_order ON store_inquiries(order_id) WHERE order_id IS NOT NULL;
ALTER TABLE store_inquiry_messages ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE store_inquiry_messages ALTER COLUMN body DROP NOT NULL;

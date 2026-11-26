-- Shopper app: items on sale (a promotion price until a date) and
-- shoppers asking a store about an item or requesting one it doesn't stock.
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_price NUMERIC(14,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_ends_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_label VARCHAR(60);

CREATE TABLE IF NOT EXISTS store_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'request')),
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(160),
  token VARCHAR(40) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiries_store ON store_inquiries(store_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS store_inquiry_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id UUID NOT NULL REFERENCES store_inquiries(id) ON DELETE CASCADE,
  from_store BOOLEAN NOT NULL DEFAULT false,
  author_name VARCHAR(120),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiry_msgs ON store_inquiry_messages(inquiry_id, created_at);

-- Repair shops: auto mechanics, phone/computer/electronics repair, general
-- engineering. A customer leaves an item (car, phone, laptop, generator...);
-- the shop records what it is and its condition, tags it with a QR code, and
-- keeps notes until it is collected.
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_business_type_check;
ALTER TABLE stores ADD CONSTRAINT stores_business_type_check CHECK (business_type IN
  ('general', 'butchery', 'abattoir', 'fresh_produce', 'ice_cream', 'bakery', 'tailor', 'laundry',
   'mechanic', 'tech_repair', 'engineering'));

-- What was left with the shop: { make, model, serial, plate, colour, mileage, ... }
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS item_details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS fault TEXT;          -- what the customer says is wrong
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS condition_notes TEXT; -- scratches, cracked screen, dents...
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS accessories TEXT;    -- charger, case, spare key...
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS diagnosis TEXT;      -- what the technician found
-- Short code printed on the QR tag stuck to the item.
ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS tag_code VARCHAR(12);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_job_orders_tag ON job_orders (store_id, tag_code) WHERE tag_code IS NOT NULL;

ALTER TABLE job_orders DROP CONSTRAINT IF EXISTS job_orders_status_check;
ALTER TABLE job_orders ADD CONSTRAINT job_orders_status_check CHECK (status IN
  ('received', 'diagnosing', 'awaiting_approval', 'waiting_parts', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled'));

-- Running notes on a job (what was checked, customer approved the quote, part ordered...).
CREATE TABLE IF NOT EXISTS job_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_notes_job ON job_notes (job_id, created_at);

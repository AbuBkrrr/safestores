-- Business types: each store picks what kind of business it is, which
-- switches on the right tools (sell by weight, fresh-food rules, production,
-- job orders). See src/utils/businessTypes.js.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS business_type VARCHAR(30) NOT NULL DEFAULT 'general';
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_business_type_check;
ALTER TABLE stores ADD CONSTRAINT stores_business_type_check CHECK (business_type IN
  ('general', 'butchery', 'abattoir', 'fresh_produce', 'ice_cream', 'bakery', 'tailor', 'laundry'));

-- How a product is sold: per item, or by weight / volume / length (decimals allowed).
ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_by VARCHAR(10) NOT NULL DEFAULT 'unit';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sold_by_check;
ALTER TABLE products ADD CONSTRAINT products_sold_by_check CHECK (sold_by IN ('unit', 'weight', 'volume', 'length'));
-- Fresh food: days it keeps after arrival (expiry is worked out from this when not given).
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0);

-- Production: recipes (ice-cream, bread: ingredients → product) and
-- break-downs (abattoir, butchery: one animal/carcass → cuts).
CREATE TABLE IF NOT EXISTS production_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  kind VARCHAR(12) NOT NULL DEFAULT 'recipe' CHECK (kind IN ('recipe', 'breakdown')),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_recipe_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES production_recipes(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  role VARCHAR(6) NOT NULL CHECK (role IN ('input', 'output')),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS production_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  recipe_id UUID REFERENCES production_recipes(id) ON DELETE SET NULL,
  kind VARCHAR(12) NOT NULL,
  batches NUMERIC(10,3) NOT NULL DEFAULT 1,
  note TEXT,
  input_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_run_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  role VARCHAR(6) NOT NULL CHECK (role IN ('input', 'output')),
  expected_qty NUMERIC(14,3),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity >= 0)
);
CREATE INDEX IF NOT EXISTS idx_production_runs_store ON production_runs(store_id, created_at DESC);

-- Services & job orders (tailor, laundry): customer measurements, deposit, status.
ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS measurements JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS job_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  ref VARCHAR(12) NOT NULL,
  store_customer_id UUID REFERENCES store_customers(id) ON DELETE SET NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(40),
  title VARCHAR(200) NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{ description, quantity, price }]
  measurements JSONB NOT NULL DEFAULT '{}'::jsonb, -- snapshot for this job
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  due_date DATE,
  status VARCHAR(12) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled')),
  notes TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_at TIMESTAMPTZ,
  UNIQUE (store_id, ref)
);
CREATE TABLE IF NOT EXISTS job_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method VARCHAR(20) NOT NULL DEFAULT 'cash',
  kind VARCHAR(10) NOT NULL DEFAULT 'deposit' CHECK (kind IN ('deposit', 'balance', 'payment')),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_orders_store ON job_orders(store_id, status, due_date);

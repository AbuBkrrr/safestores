-- Records that change after they are created (a handover being received, a
-- return taken into the store room, a job moving to "ready", a recipe being
-- edited) need an updated_at so shop computers and the cloud can sync the
-- change, latest wins. A trigger stamps it on every update unless the update
-- sets it itself — which is exactly what a sync import does, keeping the
-- time the change was really made.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_handovers', 'security_returns', 'job_orders', 'production_recipes'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t || '_touch', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (updated_at)', 'idx_' || t || '_updated', t);
  END LOOP;
END $$;

-- Orders change after payment too (refunds, the exit check), and store
-- customers' measurements are edited in place.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders (store_id, updated_at);
DROP TRIGGER IF EXISTS store_customers_touch ON store_customers;
CREATE TRIGGER store_customers_touch BEFORE UPDATE ON store_customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

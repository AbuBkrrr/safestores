-- Deleting a store must remove everything it owns. Several links (a sale
-- line -> its product, a stock record -> the staff member who made it…)
-- had no delete rule, and Postgres checks them before the store's other
-- rows are gone, so any store that had ever sold something could not be
-- deleted ("still referenced from table order_items").
--
-- Links to a product or a stock movement now follow it (the line belongs
-- to the same store); links to a staff member, an auditor or a guarantor
-- are cleared instead, keeping the record.
DO $$
DECLARE r RECORD; act TEXT;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl, a.attname AS col, c.confrelid::regclass AS ref, a.attnotnull AS notnull,
           pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.confdeltype IN ('a', 'r')
      AND c.confrelid::regclass::text IN ('products', 'stock_movements', 'users', 'customers', 'audit_engagements', 'credit_guarantors')
  LOOP
    IF r.ref::text IN ('products') OR r.notnull THEN act := 'CASCADE'; ELSE act := 'SET NULL'; END IF;
    IF r.ref::text = 'stock_movements' AND NOT r.notnull THEN act := 'SET NULL'; END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON DELETE %s', r.tbl, r.conname,
      regexp_replace(r.def, '\s+ON (DELETE|UPDATE) (NO ACTION|RESTRICT)', '', 'g'), act);
  END LOOP;
END $$;

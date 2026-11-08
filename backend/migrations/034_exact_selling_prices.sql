-- ============================================================
-- 034 — Exact selling prices
-- Selling price = cost_price × price_multiplier. With only 3 decimal
-- places, a shelf price typed or imported as e.g. 850 on a cost of 700
-- came out as 849.80. Ten decimal places keeps any realistic price exact
-- to the cent (rounding error < 0.005 for costs up to 100 million).
-- ============================================================
ALTER TABLE products ALTER COLUMN price_multiplier TYPE NUMERIC(20,10);

-- Sell by weight or measure: quantities can be fractional (1.35 kg, 0.5 litre,
-- 2.25 yards). Up to 3 decimal places; whole-unit products are unaffected.
ALTER TABLE batches ALTER COLUMN quantity_received TYPE NUMERIC(14,3);
ALTER TABLE cycle_counts ALTER COLUMN counted_qty TYPE NUMERIC(14,3);
ALTER TABLE cycle_counts ALTER COLUMN discrepancy TYPE NUMERIC(14,3);
ALTER TABLE cycle_counts ALTER COLUMN expected_qty TYPE NUMERIC(14,3);
ALTER TABLE marketplace_order_items ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE order_items ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN backroom_qty TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN damaged_qty TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN min_order_qty TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN reorder_level TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN shelf_qty TYPE NUMERIC(14,3);
ALTER TABLE products ALTER COLUMN sold_qty TYPE NUMERIC(14,3);
ALTER TABLE purchase_order_items ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE purchase_order_items ALTER COLUMN received_quantity TYPE NUMERIC(14,3);
ALTER TABLE refund_items ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE security_returns ALTER COLUMN qty_damaged TYPE NUMERIC(14,3);
ALTER TABLE security_returns ALTER COLUMN qty_resellable TYPE NUMERIC(14,3);
ALTER TABLE security_returns ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE shelf_audits ALTER COLUMN counted_qty TYPE NUMERIC(14,3);
ALTER TABLE shelf_audits ALTER COLUMN discrepancy TYPE NUMERIC(14,3);
ALTER TABLE shelf_audits ALTER COLUMN expected_qty TYPE NUMERIC(14,3);
ALTER TABLE stock_arrivals ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE stock_handover_items ALTER COLUMN qty_issued TYPE NUMERIC(14,3);
ALTER TABLE stock_handover_items ALTER COLUMN qty_received TYPE NUMERIC(14,3);
ALTER TABLE stock_movements ALTER COLUMN quantity TYPE NUMERIC(14,3);
ALTER TABLE stock_transfer_items ALTER COLUMN quantity TYPE NUMERIC(14,3);

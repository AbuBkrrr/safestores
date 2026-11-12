-- Wires up migration 026's placeholder — that migration added
-- gateway_provider/gateway_enabled to payment_settings but nothing read
-- them yet. This adds what's needed on the billing_charges side to
-- record a payment that came through the gateway rather than the manual
-- claim/confirm flow: which path paid it, and the gateway's own
-- transaction reference (for looking a charge up again from a webhook
-- or a "verify on return" callback, and for support/dispute lookups).
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS paid_via VARCHAR(20) NOT NULL DEFAULT 'manual'
  CHECK (paid_via IN ('manual', 'gateway'));
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS gateway_reference TEXT;
CREATE INDEX IF NOT EXISTS idx_billing_charges_gateway_reference ON billing_charges(gateway_reference)
  WHERE gateway_reference IS NOT NULL;

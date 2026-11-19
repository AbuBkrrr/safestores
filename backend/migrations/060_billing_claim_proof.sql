-- The receipt (photo or PDF) a store uploads when it says it has paid a charge.
ALTER TABLE billing_charges ADD COLUMN IF NOT EXISTS claim_proof_url TEXT;

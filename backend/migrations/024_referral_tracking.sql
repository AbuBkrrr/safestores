-- ============================================================
-- Referral tracking on store signup.
--
-- Captures who referred a new store at signup time (a marketer/affiliate's
-- email or phone number, whichever they gave out) so the Super Admin can
-- tally how many stores each referrer brought in — and, since a raw
-- signup count is a poor proxy for value, how many of those actually
-- became paying customers (subscription_status = 'active') — to decide
-- bonus payouts. This is intentionally just tracking + a count, not a
-- commission/payout engine — Super Admin still decides and pays bonuses
-- manually based on what this surfaces.
-- ============================================================

ALTER TABLE stores ADD COLUMN IF NOT EXISTS referral_contact VARCHAR(160);
CREATE INDEX IF NOT EXISTS idx_stores_referral_contact ON stores(referral_contact) WHERE referral_contact IS NOT NULL;

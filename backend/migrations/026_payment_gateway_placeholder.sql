-- Placeholder for a future payment gateway integration (Paystack,
-- Flutterwave, Stripe, etc). Payments today are handled entirely
-- manually — a store admin transfers/pays via the instructions in
-- payment_settings and clicks "I've Paid" (billingController.js's
-- claimPayment), then a super admin confirms it landed (markPaid).
--
-- This column ONLY records which provider a super admin intends to wire
-- up eventually — nothing reads it to actually initiate or process a
-- payment. Wiring up a real gateway means: adding that provider's SDK/API
-- calls, a webhook endpoint for payment confirmation callbacks, and
-- replacing (or offering alongside) the manual claim/confirm flow above.
-- None of that exists yet; this is deliberately just a slot for it to
-- land in later, per product decision to ship manual bank transfer for
-- launch and add automated gateway support afterward.
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS gateway_provider TEXT NOT NULL DEFAULT 'none'
  CHECK (gateway_provider IN ('none', 'paystack', 'flutterwave', 'stripe'));
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS gateway_enabled BOOLEAN NOT NULL DEFAULT false;

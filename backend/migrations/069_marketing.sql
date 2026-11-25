-- Marketing: tracking links (QR / share links), every open of them with the
-- device it came from, leads from the website form, and which sign-ups
-- each link brought in.
CREATE TABLE IF NOT EXISTS marketing_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(16) NOT NULL UNIQUE,
  label VARCHAR(120),
  channel VARCHAR(30) NOT NULL DEFAULT 'other',
  target VARCHAR(20) NOT NULL DEFAULT 'landing' CHECK (target IN ('landing', 'signup')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS marketing_opens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_code VARCHAR(16),
  device_key VARCHAR(80) NOT NULL,          -- browser's random id, or a rough signature when missing
  device_key_kind VARCHAR(10) NOT NULL DEFAULT 'id' CHECK (device_key_kind IN ('id', 'signature')),
  device_no INT NOT NULL,                   -- #1, #2… per link
  open_no INT NOT NULL,                     -- this device's nth open of this link
  device_type VARCHAR(20), os VARCHAR(40), browser VARCHAR(40), model VARCHAR(80), in_app VARCHAR(30),
  country VARCHAR(80), country_code VARCHAR(2), timezone VARCHAR(60), language VARCHAR(20), screen VARCHAR(20),
  referrer VARCHAR(300), page VARCHAR(60),
  utm_source VARCHAR(60), utm_medium VARCHAR(60), utm_campaign VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mk_opens_link ON marketing_opens(link_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mk_opens_device ON marketing_opens(device_key);
CREATE INDEX IF NOT EXISTS idx_mk_opens_time ON marketing_opens(created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_code VARCHAR(16),
  device_key VARCHAR(80),
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(160),
  shop VARCHAR(160),
  topic VARCHAR(30),
  message TEXT,
  country VARCHAR(80), language VARCHAR(20),
  consent BOOLEAN NOT NULL DEFAULT false,   -- agreed to be contacted about SAFE Stores
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'registered', 'not_interested')),
  notes TEXT,
  unsubscribe_token VARCHAR(40) NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  unsubscribed_at TIMESTAMPTZ,
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mk_leads_time ON marketing_leads(created_at DESC);

ALTER TABLE stores ADD COLUMN IF NOT EXISTS ref_code VARCHAR(16);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS ref_device_key VARCHAR(80);

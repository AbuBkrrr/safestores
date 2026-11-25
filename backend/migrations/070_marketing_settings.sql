-- Where marketing links and QR codes point (set by Super Admin in Marketing).
CREATE TABLE IF NOT EXISTS marketing_settings (
  id VARCHAR(20) PRIMARY KEY DEFAULT 'default',
  link_base TEXT,      -- e.g. https://app.safestores.com.ng  (links look like <link_base>/go/<code>)
  landing_url TEXT,    -- the website the "website" links open, e.g. https://safestores.com.ng/
  signup_url TEXT,     -- the app sign-up page "straight to sign-up" links open
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_settings (id) VALUES ('default') ON CONFLICT DO NOTHING;

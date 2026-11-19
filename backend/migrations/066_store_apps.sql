-- Each store's own Windows installer and Android app (built from
-- templates/store-app by the "Store apps" GitHub workflow).
CREATE TABLE IF NOT EXISTS store_apps (
  store_id        UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued | building | ready | failed | not_configured
  brand_name      VARCHAR(120) NOT NULL,
  download_token  VARCHAR(64) NOT NULL UNIQUE,
  windows_url     TEXT,
  android_url     TEXT,
  error           TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at        TIMESTAMPTZ
);

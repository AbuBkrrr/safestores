-- "In-store only": when switched on, shop-floor staff can only change
-- things (sell, receive, move stock...) from the shop — on one of its
-- internet connections, or with their phone's GPS inside the shop radius.
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS onsite_lock BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onsite_networks JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS onsite_lat NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS onsite_lng NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS onsite_radius_m INTEGER NOT NULL DEFAULT 100
    CHECK (onsite_radius_m BETWEEN 30 AND 2000);

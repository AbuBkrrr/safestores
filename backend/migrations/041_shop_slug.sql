-- Custom storefront address: /shop/<shop_slug> instead of /shop/<store uuid>.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_slug VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS stores_shop_slug_key ON stores (shop_slug) WHERE shop_slug IS NOT NULL;
-- A short line shown under the store name on the storefront.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_tagline VARCHAR(140);

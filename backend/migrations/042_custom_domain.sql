-- A store's own domain (e.g. shop.mamangozi.com) that opens its storefront.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(253);
CREATE UNIQUE INDEX IF NOT EXISTS stores_custom_domain_key ON stores (custom_domain) WHERE custom_domain IS NOT NULL;

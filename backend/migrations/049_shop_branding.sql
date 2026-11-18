-- Storefront branding: each shop's own logo, colours, font and background.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_logo_url TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_bg_image_url TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_brand_color VARCHAR(7);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_bg_color VARCHAR(7);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_font VARCHAR(40);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_theme VARCHAR(10);

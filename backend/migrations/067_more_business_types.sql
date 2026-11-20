-- Restaurants and building-materials stores.
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_business_type_check;
ALTER TABLE stores ADD CONSTRAINT stores_business_type_check CHECK (business_type IN
  ('general', 'butchery', 'abattoir', 'fresh_produce', 'ice_cream', 'bakery', 'tailor', 'laundry',
   'mechanic', 'tech_repair', 'engineering', 'restaurant', 'building_materials'));

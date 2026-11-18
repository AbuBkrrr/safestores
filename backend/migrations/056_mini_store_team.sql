-- Mini store = a small shop run by the owner with at most a couple of helpers.
-- Owner + 2 helpers. (Midi 20, Mega unlimited are unchanged; Super Admin can still edit.)
UPDATE store_tiers SET max_users = 3 WHERE tier = 'mini' AND (max_users IS NULL OR max_users = 5);

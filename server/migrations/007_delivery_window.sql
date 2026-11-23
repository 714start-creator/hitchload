-- Optional delivery window: deliver from / no later than. Loading windows may now span several days.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_start timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_end timestamptz;

-- Basic drivers with a delivery endorsement or a commercial policy: item value limit 4000 dollars (was 1000).
UPDATE drivers d SET cargo_limit_cents = 400000
 WHERE d.tier = 'basic' AND d.cargo_limit_cents = 100000
   AND EXISTS (SELECT 1 FROM documents x WHERE x.driver_id = d.user_id AND x.kind IN ('insurance_endorsement', 'insurance_commercial') AND x.status <> 'rejected');

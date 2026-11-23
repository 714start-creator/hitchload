-- Basic drivers covered only by a personal auto policy: item value limit 2500 dollars (was 1000).
UPDATE drivers d SET cargo_limit_cents = 250000
 WHERE d.tier = 'basic' AND d.cargo_limit_cents = 100000
   AND EXISTS (SELECT 1 FROM documents x WHERE x.driver_id = d.user_id AND x.kind = 'insurance_auto' AND x.status <> 'rejected')
   AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.driver_id = d.user_id AND x.kind IN ('insurance_endorsement', 'insurance_commercial') AND x.status <> 'rejected');

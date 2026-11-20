// Demo data for a development database: an admin, two approved drivers and
// published trips around Alberta, so the app has something to show.
// Run: npm run seed   (never against production)
import { loadConfig } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { findCity } from '../data/cities.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
if (cfg.prod) throw new Error('Refusing to seed a production database');
const db = await createDb(cfg.databaseUrl);
await migrate(db);

const admin = cfg.adminPhones[0] ?? '+17800000001';
await db.query(`INSERT INTO users(phone, name, email, is_admin, terms_accepted_at) VALUES ($1, 'Admin', 'admin@example.com', true, now()) ON CONFLICT (phone) DO UPDATE SET is_admin = true`, [admin]);

const drivers = [
  { phone: '+17805550200', name: 'Mike Romanenko', tier: 'pro', vehicle: ['pickup', 'Ram', '1500', true], limit: 2_500_000 },
  { phone: '+17805550300', name: 'Olena Koval', tier: 'basic', vehicle: ['cargo_van', 'Ford', 'Transit', false], limit: 100_000 },
] as const;

for (const d of drivers) {
  const [u] = await db.query<{ id: string }>(
    `INSERT INTO users(phone, name, email, terms_accepted_at, rating_sum, rating_count) VALUES ($1, $2, $3, now(), 49, 10)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [d.phone, d.name, d.name.split(' ')[0]!.toLowerCase() + '@example.com'],
  );
  const id = u!.id;
  await db.query(
    `INSERT INTO drivers(user_id, status, tier, legal_name, address, date_of_birth, home_city, home_lat, home_lng, radius_km, tax_id_type, tax_id_enc, tax_id_last3,
       payouts_enabled, stripe_account_id, identity_status, background_status, agreement_accepted_at, quiz_passed_at, cargo_limit_cents, approved_at, submitted_at)
     VALUES ($1, 'approved', $2, $3, '10220 104 Ave NW, Edmonton AB', '1988-04-12', 'Edmonton', 53.5461, -113.4938, 60, 'sin', $4, '286',
       true, $5, 'verified', 'clear', now(), now(), $6, now(), now())
     ON CONFLICT (user_id) DO NOTHING`,
    [id, d.tier, d.name, encrypt('046454286', cfg.dataKey), `acct_demo_${id.slice(0, 8)}`, d.limit],
  );
  const docs: [string, number | null][] = [['license_front', null], ['license_back', null], ['registration', null], ['background_check', null], ['vehicle_side', null], ['vehicle_rear', null], [d.tier === 'pro' ? 'insurance_commercial' : 'insurance_endorsement', null]];
  if (d.tier === 'pro') docs.push(['insurance_cargo', d.limit]);
  for (const [kind, coverage] of docs) {
    await db.query(
      `INSERT INTO documents(driver_id, kind, file_key, status, insurer, policy_number, coverage_cents, expires_on, reviewed_at)
       SELECT $1::uuid, $2::doc_kind, 'u/' || $5 || '/document/demo-' || $4 || '.jpg', 'approved', CASE WHEN $4 LIKE 'insurance%' THEN 'Demo Insurance' END,
              CASE WHEN $4 LIKE 'insurance%' THEN 'DEMO-' || upper(substr($4, 11, 3)) END, $3::int, CASE WHEN $4 LIKE 'insurance%' THEN current_date + 300 END, now()
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE driver_id = $1::uuid AND kind = $2::doc_kind)`,
      [id, kind, coverage, kind, id],
    );
  }
  const [type, make, model, trailer] = d.vehicle;
  const [v] = await db.query<{ id: string }>(
    `INSERT INTO vehicles(driver_id, type, make, model, year, plate, registered_weight_kg, has_trailer, max_size, equipment)
     SELECT $1::uuid, $2::vehicle_type, $3::text, $4::text, 2021, 'DEMO' || upper(substr($7, 1, 3)), 3200, $5::boolean, $6::size_class, '{straps,blankets}'
     WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE driver_id = $1::uuid) RETURNING id`,
    [id, type, make, model, trailer, 'XL', id],
  );
  const vid = v?.id ?? (await db.query<{ id: string }>('SELECT id FROM vehicles WHERE driver_id = $1 LIMIT 1', [id]))[0]!.id;
  const routes = d.tier === 'pro'
    ? [[['Edmonton', 'Red Deer', 'Calgary'], 5], [['Calgary', 'Red Deer', 'Edmonton'], 30]]
    : [[['Edmonton', 'Calgary'], 20], [['Edmonton', 'Lloydminster', 'North Battleford', 'Saskatoon'], 26]];
  // only when the driver has no upcoming trips (the seed may run on every restart of a demo server)
  const upcoming = await db.query('SELECT 1 FROM trips WHERE driver_id = $1 AND status = \'active\' AND depart_at > now()', [id]);
  if (upcoming.length) continue;
  for (const [names, inHours] of routes as [string[], number][]) {
    const stops = names.map((n) => findCity(n)!);
    await db.query(
      `INSERT INTO trips(driver_id, vehicle_id, stops, depart_at, space, max_size) VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, 'half', 'XL')`,
      [id, vid, JSON.stringify(stops), String(inHours)],
    );
  }
}
console.log(`Seeded. Admin phone: ${admin}. Demo drivers: ${drivers.map((d) => d.phone).join(', ')}`);
await db.close();

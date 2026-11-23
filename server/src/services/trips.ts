// "I'm driving": drivers publish routes; customers see which ones pass their
// pickup and dropoff, when the driver will be there, and the on-the-way price.
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { one } from '../db/db.js';
import { CITIES, findCity } from '../data/cities.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import { matchRoute, type Point, type Stop } from '../lib/geo.js';
import { cargoLimitCents, tripPriceCents, type Size } from '../lib/pricing.js';
import { getDriver } from './drivers.js';
import { firstName, rating } from './dto.js';

const SIZE_RANK: Record<Size, number> = { S: 0, M: 1, L: 2, XL: 3, AUTO: 4 };
export const sizeFits = (cargo: Size, capacity: Size) => (cargo === 'AUTO' ? capacity === 'AUTO' : SIZE_RANK[cargo] <= Math.min(SIZE_RANK[capacity], SIZE_RANK.XL));

export interface TripRow {
  id: string;
  driver_id: string;
  vehicle_id: string | null;
  stops: Stop[];
  depart_at: string;
  space: string;
  max_size: Size;
  status: 'active' | 'cancelled' | 'completed';
  note: string | null;
  created_at: string;
}

const stopSchema = z.union([
  z.object({ city: z.string().min(2), province: z.string().length(2) }),
  z.object({ city: z.string().min(2), province: z.string().length(2), lat: z.number(), lng: z.number() }),
]);

export const tripSchema = z.object({
  stops: z.array(stopSchema).min(2).max(8),
  departAt: z.string().datetime({ offset: true }),
  space: z.enum(['quarter', 'half', 'full']).default('half'),
  vehicleId: z.string().uuid().optional(),
  note: z.string().max(200).optional(),
});

export async function createTrip(ctx: Ctx, userId: string, p: z.infer<typeof tripSchema>) {
  const d = await getDriver(ctx.db, userId);
  if (d.status !== 'approved') throw conflict('not_approved', 'Only approved drivers can publish trips');
  const depart = new Date(p.departAt);
  const now = ctx.now();
  if (depart.getTime() < now.getTime() - 15 * 60_000) throw bad('in_the_past', 'Departure time is in the past');
  if (depart.getTime() > now.getTime() + 30 * 86_400_000) throw bad('too_far', 'Trips can be published up to 30 days ahead');
  const stops: Stop[] = p.stops.map((s) => {
    if ('lat' in s) return { city: s.city, province: s.province.toUpperCase(), lat: s.lat, lng: s.lng };
    const c = findCity(s.city, s.province);
    if (!c) throw bad('unknown_city', `Unknown city: ${s.city}`);
    return c;
  });
  // the same city twice in a row is allowed: a trip around town (Edmonton → Edmonton) carries local loads
  const vehicles = await ctx.db.query<{ id: string; max_size: Size }>('SELECT id, max_size FROM vehicles WHERE driver_id = $1 AND active', [userId]);
  const vehicle = p.vehicleId ? vehicles.find((v) => v.id === p.vehicleId) : vehicles[0];
  if (!vehicle) throw bad('no_vehicle', 'Add a vehicle first');
  const row = await one<TripRow>(
    ctx.db,
    `INSERT INTO trips(driver_id, vehicle_id, stops, depart_at, space, max_size, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, vehicle.id, JSON.stringify(stops), depart.toISOString(), p.space, vehicle.max_size, p.note ?? null],
  );
  return tripDto(row);
}

export async function cancelTrip(ctx: Ctx, userId: string, tripId: string) {
  const rows = await ctx.db.query(`UPDATE trips SET status = 'cancelled' WHERE id = $1 AND driver_id = $2 AND status = 'active' RETURNING id`, [tripId, userId]);
  if (!rows.length) throw notFound('Trip not found');
  // pending booking requests on this trip go to everyone
  await ctx.db.query(
    `UPDATE orders SET requested_driver_id = NULL, request_expires_at = NULL, pro_until = now() WHERE trip_id = $1 AND status = 'open' AND requested_driver_id = $2`,
    [tripId, userId],
  );
}

export async function myTrips(ctx: Ctx, userId: string) {
  const rows = await ctx.db.query<TripRow>(
    `SELECT * FROM trips WHERE driver_id = $1 AND status = 'active' AND depart_at > now() - interval '1 day' ORDER BY depart_at`,
    [userId],
  );
  return rows.map(tripDto);
}

export const tripDto = (t: TripRow) => ({ id: t.id, stops: t.stops, departAt: t.depart_at, space: t.space, maxSize: t.max_size, status: t.status, note: t.note });

export interface TripOption {
  tripId: string;
  driver: { name: string | null; rating: number | null; tier: string; vehicle: string; completedJobs: number };
  stops: Stop[];
  departAt: string;
  pickupEta: string;
  dropoffEta: string;
  space: string;
  priceCents: number;
  fitsWindow: boolean;
}

/** Published trips that pass the pickup and then the dropoff, soonest first. */
export async function matchTrips(
  ctx: Ctx,
  q: { pickup: Point; dropoff: Point; size: Size; km: number; declaredValueCents: number; insured: boolean; windowStart?: Date; windowEnd?: Date; excludeDriver?: string },
): Promise<TripOption[]> {
  const rows = await ctx.db.query<
    TripRow & { name: string | null; rating_sum: number; rating_count: number; tier: 'basic' | 'pro'; cargo_limit_cents: number; completed_jobs: number; make: string; model: string }
  >(
    `SELECT t.*, u.name, u.rating_sum, u.rating_count, d.tier, d.cargo_limit_cents, d.completed_jobs, v.make, v.model
     FROM trips t JOIN drivers d ON d.user_id = t.driver_id JOIN users u ON u.id = t.driver_id LEFT JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.status = 'active' AND d.status = 'approved' AND t.depart_at > $1::timestamptz - interval '2 hours' AND t.depart_at < $1::timestamptz + interval '14 days'
     ORDER BY t.depart_at LIMIT 500`,
    [ctx.now().toISOString()],
  );
  const r = ctx.cfg.rules;
  const out: TripOption[] = [];
  for (const t of rows) {
    if (t.driver_id === q.excludeDriver) continue;
    if (!sizeFits(q.size, t.max_size)) continue;
    const limit = cargoLimitCents({ tier: t.tier, cargoLimitCents: t.cargo_limit_cents }, q.insured ?? false, r);
    if (q.declaredValueCents > limit) continue;
    const m = matchRoute(t.stops, q.pickup, q.dropoff, r.stopMatchKm, r.roadFactor);
    if (!m) continue;
    const dep = new Date(t.depart_at).getTime();
    const pickupEta = new Date(dep + (m.kmToPickup / r.avgSpeedKmh) * 3_600_000);
    if (pickupEta.getTime() < ctx.now().getTime()) continue; // already passed the pickup
    const dropoffEta = new Date(dep + (m.kmToDropoff / r.avgSpeedKmh) * 3_600_000);
    out.push({
      tripId: t.id,
      driver: { name: firstName(t.name), rating: rating(t.rating_sum, t.rating_count), tier: t.tier, vehicle: [t.make, t.model].filter(Boolean).join(' '), completedJobs: t.completed_jobs },
      stops: t.stops,
      departAt: t.depart_at,
      pickupEta: pickupEta.toISOString(),
      dropoffEta: dropoffEta.toISOString(),
      space: t.space,
      priceCents: tripPriceCents(q.size, q.km, r),
      fitsWindow: q.windowStart && q.windowEnd ? pickupEta >= q.windowStart && pickupEta <= q.windowEnd : false,
    });
  }
  return out.sort((a, b) => Number(b.fitsWindow) - Number(a.fitsWindow) || a.pickupEta.localeCompare(b.pickupEta)).slice(0, 30);
}

/** For the route map: active trips touching a province, with stops only. */
export async function tripsMap(ctx: Ctx, province?: string) {
  const rows = await ctx.db.query<TripRow>(
    `SELECT t.* FROM trips t JOIN drivers d ON d.user_id = t.driver_id
     WHERE t.status = 'active' AND d.status = 'approved' AND t.depart_at > now() - interval '2 hours' AND t.depart_at < now() + interval '3 days'
     ORDER BY t.depart_at LIMIT 300`,
  );
  return rows
    .filter((t) => !province || t.stops.some((s) => s.province === province))
    .map((t) => ({ id: t.id, stops: t.stops.map((s) => ({ city: s.city, province: s.province, lat: s.lat, lng: s.lng })), departAt: t.depart_at }));
}

export const cityList = () => CITIES;

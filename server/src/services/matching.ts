// Route matching between drivers' trips and shippers:
//  - a driver publishes a trip → loads along it, and shippers waiting on that route are told;
//  - a shipper saves a route alert → told about every new driver trip on it;
//  - a shipper with an open order can ask a specific driver's trip to take it;
//  - public search: who is driving from A to B, and which loads are waiting.
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { one } from '../db/db.js';
import { findCity } from '../data/cities.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import { matchRoute, roadKm, sameCity, type Stop } from '../lib/geo.js';
import { fmtCad, SIZES, type Size } from '../lib/pricing.js';
import { momentInZone, provinceTz } from '../lib/tz.js';
import { evaluate, loadDriverContext } from './dispatch.js';
import { firstName, orderDto, type OrderRow } from './dto.js';
import { notify } from './notify.js';
import { matchTrips, sizeFits, type TripRow } from './trips.js';
import { linkSig } from './users.js';

const citySchema = z.object({ city: z.string().trim().min(2).max(80), province: z.string().trim().length(2) });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const alertSchema = z.object({
  from: citySchema,
  to: citySchema,
  size: z.enum(SIZES as [Size, ...Size[]]).optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
});

interface AlertRow {
  id: string;
  user_id: string;
  origin: Stop;
  destination: Stop;
  size: Size | null;
  date_from: string | null;
  date_to: string | null;
  active: boolean;
  created_at: string;
}

function city(c: { city: string; province: string }): Stop {
  const found = findCity(c.city, c.province.toUpperCase());
  if (!found) throw bad('unknown_city', `Unknown city: ${c.city}`);
  return { city: found.city, province: found.province, lat: found.lat, lng: found.lng };
}

/** YYYY-MM-DD of an instant in the display time zone. */
const localDate = (tz: string, d: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const shortDate = (d: string, province: string, lang: string) => momentInZone(d, provinceTz(province), lang);
const routeText = (stops: Stop[]) => stops.map((s) => s.city).join(' → ');

const alertDto = (a: AlertRow) => ({ id: a.id, from: a.origin, to: a.destination, size: a.size, dateFrom: a.date_from, dateTo: a.date_to, active: a.active, createdAt: a.created_at });

// ---------------------------------------------------------------- search (public)

/** Drivers' trips from city A to city B (optionally on a date and for a size), soonest first. */
export async function searchTrips(ctx: Ctx, q: { from: { city: string; province: string }; to: { city: string; province: string }; size?: Size; date?: string; excludeDriver?: string }) {
  const a = city(q.from);
  const b = city(q.to);
  if (sameCity(a, b, ctx.cfg.rules.cityRadiusKm)) throw bad('same_city', 'Pick two different cities');
  const km = roadKm(a, b, ctx.cfg.rules.roadFactor);
  const trips = await matchTrips(ctx, { pickup: a, dropoff: b, size: q.size ?? 'S', km, declaredValueCents: 0, insured: false, excludeDriver: q.excludeDriver });
  return { from: a, to: b, distanceKm: km, trips: q.date ? trips.filter((t) => localDate(provinceTz(a.province), t.pickupEta) === q.date) : trips };
}

/** Open loads for the public board: cities only, no addresses, names or descriptions. */
export async function publicLoads(ctx: Ctx, q: { from?: string; to?: string; province?: string }) {
  const rows = await ctx.db.query<OrderRow>(
    `SELECT * FROM orders WHERE status = 'open' AND window_end > $1::timestamptz AND (requested_driver_id IS NULL OR request_expires_at < $1::timestamptz)
     ORDER BY created_at DESC LIMIT 300`,
    [ctx.now().toISOString()],
  );
  const like = (v: string | undefined, c: string) => !v || c.toLowerCase().startsWith(v.trim().toLowerCase());
  return rows
    .filter((o) => like(q.from, o.pickup.city) && like(q.to, o.dropoff.city) && (!q.province || o.pickup.province === q.province || o.dropoff.province === q.province))
    .slice(0, 100)
    .map((o) => ({
      number: o.number,
      from: { city: o.pickup.city, province: o.pickup.province },
      to: { city: o.dropoff.city, province: o.dropoff.province },
      intercity: o.intercity,
      distanceKm: o.distance_km,
      size: o.size,
      windowStart: o.window_start,
      windowEnd: o.window_end,
      // what the driver receives before the driver fee
      priceCents: o.price_cents,
      postedAt: o.created_at,
    }));
}

export async function publicStats(ctx: Ctx) {
  const [s] = await ctx.db.query<{ drivers: number; trips: number; loads: number; delivered: number }>(
    `SELECT (SELECT count(*)::int FROM drivers WHERE status = 'approved') AS drivers,
            (SELECT count(*)::int FROM trips WHERE status = 'active' AND depart_at > now()) AS trips,
            (SELECT count(*)::int FROM orders WHERE status = 'open' AND window_end > now()) AS loads,
            (SELECT count(*)::int FROM orders WHERE status = 'delivered') AS delivered`,
  );
  return s;
}

// ---------------------------------------------------------------- alerts (shippers)

export async function createAlert(ctx: Ctx, userId: string, p: z.infer<typeof alertSchema>) {
  const origin = city(p.from);
  const destination = city(p.to);
  if (sameCity(origin, destination, ctx.cfg.rules.cityRadiusKm)) throw bad('same_city', 'Pick two different cities');
  if (p.dateFrom && p.dateTo && p.dateTo < p.dateFrom) throw bad('bad_dates', 'The end date is before the start date');
  const [{ n }] = (await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM route_alerts WHERE user_id = $1 AND active', [userId])) as [{ n: number }];
  if (n >= 20) throw conflict('too_many_alerts', 'You can keep up to 20 route alerts. Delete one first');
  const dup = await ctx.db.query<AlertRow>(
    `SELECT * FROM route_alerts WHERE user_id = $1 AND active AND origin->>'city' = $2 AND destination->>'city' = $3
       AND size IS NOT DISTINCT FROM $4 AND date_from IS NOT DISTINCT FROM $5::date AND date_to IS NOT DISTINCT FROM $6::date`,
    [userId, origin.city, destination.city, p.size ?? null, p.dateFrom ?? null, p.dateTo ?? null],
  );
  const row = dup[0] ?? await one<AlertRow>(
    ctx.db,
    `INSERT INTO route_alerts(user_id, origin, destination, size, date_from, date_to) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, JSON.stringify(origin), JSON.stringify(destination), p.size ?? null, p.dateFrom ?? null, p.dateTo ?? null],
  );
  const found = await searchTrips(ctx, { from: origin, to: destination, size: p.size, excludeDriver: userId });
  const trips = found.trips.filter((t) => {
    const d = localDate(provinceTz(t.stops[0]?.province), t.departAt);
    return (!p.dateFrom || d >= p.dateFrom) && (!p.dateTo || d <= p.dateTo);
  });
  return { alert: alertDto(row), trips };
}

export async function listAlerts(ctx: Ctx, userId: string) {
  const rows = await ctx.db.query<AlertRow>('SELECT * FROM route_alerts WHERE user_id = $1 AND active ORDER BY created_at DESC', [userId]);
  return rows.map(alertDto);
}

export async function deleteAlert(ctx: Ctx, userId: string, id: string) {
  const r = await ctx.db.query('UPDATE route_alerts SET active = false WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (!r.length) throw notFound('Alert not found');
}

export const alertUnsubscribeUrl = (ctx: Ctx, alertId: string) => `${ctx.cfg.publicUrl}/v1/alerts/${alertId}/unsubscribe?s=${linkSig(ctx, 'alert:' + alertId)}`;

/** One-click link in the email; no sign-in needed. */
export async function unsubscribeAlert(ctx: Ctx, id: string, sig: string): Promise<boolean> {
  if (sig !== linkSig(ctx, 'alert:' + id)) return false;
  await ctx.db.query('UPDATE route_alerts SET active = false WHERE id = $1', [id]);
  return true;
}

// ---------------------------------------------------------------- a driver published a trip

const ETA_SLACK_MS = 24 * 3_600_000;

/** Tell shippers whose open order or saved alert lies on this trip. Each person hears about a trip once. */
export async function onTripCreated(ctx: Ctx, trip: TripRow): Promise<{ shippersNotified: number }> {
  const r = ctx.cfg.rules;
  const [drv] = await ctx.db.query<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [trip.driver_id]);
  const driverName = firstName(drv?.name ?? null) ?? 'A driver';
  const dep = new Date(trip.depart_at).getTime();
  const told = new Set<string>([trip.driver_id]);
  const langs = new Map<string, string>();
  const langOf = async (userId: string) => {
    if (!langs.has(userId)) langs.set(userId, (await ctx.db.query<{ lang: string }>('SELECT lang FROM users WHERE id = $1', [userId]))[0]?.lang ?? 'en');
    return langs.get(userId)!;
  };

  // 1. open orders on the route
  const orders = await ctx.db.query<OrderRow>(
    `SELECT * FROM orders WHERE status = 'open' AND window_end > $1::timestamptz AND client_id <> $2 AND requested_driver_id IS NULL ORDER BY created_at LIMIT 1000`,
    [ctx.now().toISOString(), trip.driver_id],
  );
  for (const o of orders) {
    if (told.has(o.client_id) || !sizeFits(o.size, trip.max_size)) continue;
    const m = matchRoute(trip.stops, o.pickup, o.dropoff, r.stopMatchKm, r.roadFactor);
    if (!m) continue;
    const eta = dep + (m.kmToPickup / r.avgSpeedKmh) * 3_600_000;
    if (eta > new Date(o.window_end).getTime() || eta < new Date(o.window_start).getTime() - ETA_SLACK_MS) continue;
    if (o.delivery_end && dep + (m.kmToDropoff / r.avgSpeedKmh) * 3_600_000 > new Date(o.delivery_end).getTime()) continue;
    const ins = await ctx.db.query(`INSERT INTO trip_matches(trip_id, kind, target_id) VALUES ($1, 'order', $2) ON CONFLICT DO NOTHING RETURNING trip_id`, [trip.id, o.id]);
    if (!ins.length) continue;
    told.add(o.client_id);
    await notify(ctx, o.client_id, 'driver_on_your_order', { driver: driverName, route: routeText(trip.stops), date: shortDate(trip.depart_at, trip.stops[0]!.province, await langOf(o.client_id)), number: o.number }, { orderId: o.id, link: `/o/${o.id}?trip=${trip.id}` });
  }

  // 2. saved route alerts
  const departDay = localDate(provinceTz(trip.stops[0]?.province), trip.depart_at);
  const alerts = await ctx.db.query<AlertRow>(
    `SELECT * FROM route_alerts WHERE active AND user_id <> $1 AND (date_from IS NULL OR date_from <= $2::date) AND (date_to IS NULL OR date_to >= $2::date) LIMIT 5000`,
    [trip.driver_id, departDay],
  );
  for (const a of alerts) {
    if (told.has(a.user_id) || (a.size && !sizeFits(a.size, trip.max_size))) continue;
    if (!matchRoute(trip.stops, a.origin, a.destination, r.stopMatchKm, r.roadFactor)) continue;
    const ins = await ctx.db.query(`INSERT INTO trip_matches(trip_id, kind, target_id) VALUES ($1, 'alert', $2) ON CONFLICT DO NOTHING RETURNING trip_id`, [trip.id, a.id]);
    if (!ins.length) continue;
    told.add(a.user_id);
    const qs = new URLSearchParams({ from: `${a.origin.city}, ${a.origin.province}`, to: `${a.destination.city}, ${a.destination.province}`, trip: trip.id });
    await notify(ctx, a.user_id, 'driver_on_alert', { driver: driverName, route: `${a.origin.city} → ${a.destination.city}`, date: shortDate(trip.depart_at, trip.stops[0]!.province, await langOf(a.user_id)) }, { link: `/send?${qs}`, unsubscribe: alertUnsubscribeUrl(ctx, a.id) });
  }
  return { shippersNotified: told.size - 1 };
}

/** Loads along one of the driver's trips, with what the driver may do with each. */
export async function tripLoads(ctx: Ctx, driverId: string, tripId: string) {
  const [trip] = await ctx.db.query<TripRow>('SELECT * FROM trips WHERE id = $1 AND driver_id = $2', [tripId, driverId]);
  if (!trip) throw notFound('Trip not found');
  const dc = await loadDriverContext(ctx.db, driverId);
  if (!dc || dc.driver.status !== 'approved') return { trip: { id: trip.id, stops: trip.stops, departAt: trip.depart_at }, items: [] };
  const r = ctx.cfg.rules;
  const rows = await ctx.db.query<OrderRow>(
    `SELECT * FROM orders WHERE status = 'open' AND window_end > $1::timestamptz AND client_id <> $2 ORDER BY window_start LIMIT 1000`,
    [ctx.now().toISOString(), driverId],
  );
  const dep = new Date(trip.depart_at).getTime();
  const items = [];
  for (const o of rows) {
    if (!sizeFits(o.size, trip.max_size)) continue;
    const m = matchRoute(trip.stops, o.pickup, o.dropoff, r.stopMatchKm, r.roadFactor);
    if (!m) continue;
    const e = evaluate(ctx, o, dc);
    if (!e.visible) continue;
    const pickupEta = new Date(dep + (m.kmToPickup / r.avgSpeedKmh) * 3_600_000);
    if (o.delivery_end && dep + (m.kmToDropoff / r.avgSpeedKmh) * 3_600_000 > new Date(o.delivery_end).getTime()) continue; // too late for the deadline
    const fitsWindow = pickupEta >= new Date(o.window_start) && pickupEta <= new Date(o.window_end);
    items.push({ ...orderDto(o, 'prospect', { urls: (k) => ctx.storage.url(k) }), eligibility: e, pickupEta: pickupEta.toISOString(), fitsWindow });
  }
  items.sort((a, b) => Number(b.fitsWindow) - Number(a.fitsWindow) || a.pickupEta.localeCompare(b.pickupEta));
  return { trip: { id: trip.id, stops: trip.stops, departAt: trip.depart_at }, items: items.slice(0, 100) };
}

// ---------------------------------------------------------------- shipper asks a trip to take an open order

export async function requestTrip(ctx: Ctx, clientId: string, orderId: string, tripId: string) {
  const [o] = await ctx.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND client_id = $2', [orderId, clientId]);
  if (!o) throw notFound('Order not found');
  if (o.status !== 'open') throw conflict('not_open', 'This order already has a driver');
  if (o.requested_driver_id && o.request_expires_at && new Date(o.request_expires_at) > ctx.now()) throw conflict('request_pending', 'You already asked a driver. Wait for the answer');
  const options = await matchTrips(ctx, { pickup: o.pickup, dropoff: o.dropoff, size: o.size, km: o.distance_km, declaredValueCents: o.declared_value_cents, insured: o.insured, excludeDriver: clientId });
  if (!options.some((t) => t.tripId === tripId)) throw bad('trip_unavailable', 'This trip does not fit your order');
  const [trip] = await ctx.db.query<{ driver_id: string }>('SELECT driver_id FROM trips WHERE id = $1', [tripId]);
  if (!trip) throw notFound('Trip not found');
  const expires = new Date(Math.min(ctx.now().getTime() + ctx.cfg.rules.tripRequestTimeoutSec * 1000, new Date(o.window_end).getTime()));
  const upd = await ctx.db.query<OrderRow>(
    `UPDATE orders SET requested_driver_id = $2, request_expires_at = $3, trip_id = $4, updated_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
    [orderId, trip.driver_id, expires.toISOString(), tripId],
  );
  const u = upd[0];
  if (!u) throw conflict('not_open', 'This order already has a driver');
  await ctx.db.query(`INSERT INTO order_events(order_id, actor_id, type, data) VALUES ($1, $2, 'trip_requested', $3)`, [orderId, clientId, { tripId }]);
  await notify(ctx, trip.driver_id, 'trip_request', { route: `${o.pickup.city} → ${o.dropoff.city}`, price: fmtCad(o.price_cents), number: o.number }, { orderId });
  ctx.hub.publish(clientId, 'order', { orderId, status: u.status });
  ctx.hub.publish(trip.driver_id, 'order', { orderId, status: u.status });
  return { ok: true, requestExpiresAt: expires.toISOString() };
}

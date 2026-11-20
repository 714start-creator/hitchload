// Who may see and take an order, and who gets notified about it.
import type { Ctx } from '../ctx.js';
import type { Queryable } from '../db/db.js';
import { haversineKm, matchRoute, type Point } from '../lib/geo.js';
import { cargoLimitCents, fmtCad, type Size } from '../lib/pricing.js';
import type { DriverRow, OrderRow } from './dto.js';
import { notify } from './notify.js';
import { sizeFits, type TripRow } from './trips.js';

export type LockReason = 'pro_window' | 'cargo_limit' | 'client_payment';

export interface Eligibility {
  visible: boolean;
  canTake: boolean;
  lockReason?: LockReason;
  opensAt?: string;
  requestedToMe: boolean;
  onMyTrip: boolean;
  /** pickup within the driver's local radius */
  near: boolean;
  /** item is bigger than the driver's vehicles (shown as a warning; the driver decides) */
  sizeWarning: boolean;
  distanceToPickupKm: number | null;
}

export interface DriverContext {
  driver: DriverRow;
  vehicleSizes: Size[];
  trips: Pick<TripRow, 'id' | 'stops' | 'depart_at'>[];
}

export async function loadDriverContext(q: Queryable, userId: string): Promise<DriverContext | null> {
  const [driver] = await q.query<DriverRow>('SELECT * FROM drivers WHERE user_id = $1', [userId]);
  if (!driver) return null;
  const vehicles = await q.query<{ max_size: Size }>('SELECT max_size FROM vehicles WHERE driver_id = $1 AND active', [userId]);
  const trips = await q.query<TripRow>(`SELECT id, stops, depart_at FROM trips WHERE driver_id = $1 AND status = 'active' AND depart_at > now() - interval '1 day'`, [userId]);
  return { driver, vehicleSizes: vehicles.map((v) => v.max_size), trips };
}

export function evaluate(ctx: Ctx, o: OrderRow, dc: DriverContext, now = ctx.now()): Eligibility {
  const d = dc.driver;
  const no: Eligibility = { visible: false, canTake: false, requestedToMe: false, onMyTrip: false, near: false, sizeWarning: false, distanceToPickupKm: null };
  if (o.status !== 'open' || d.status !== 'approved' || o.client_id === d.user_id) return no;
  const requestActive = o.requested_driver_id && o.request_expires_at && new Date(o.request_expires_at) > now;
  const requestedToMe = Boolean(requestActive && o.requested_driver_id === d.user_id);
  if (requestActive && !requestedToMe) return no;
  // any approved driver may take any open order; size is a warning, not a lock
  const sizeWarning = !dc.vehicleSizes.some((s) => sizeFits(o.size, s)) || (o.size === 'AUTO' && !d.car_hauler);

  const r = ctx.cfg.rules;
  const here: Point | null = d.last_lat !== null && d.last_lng !== null && d.last_seen_at && now.getTime() - new Date(d.last_seen_at).getTime() < 3 * 3_600_000
    ? { lat: d.last_lat, lng: d.last_lng }
    : d.home_lat !== null && d.home_lng !== null ? { lat: d.home_lat, lng: d.home_lng } : null;
  const distanceToPickupKm = here ? Math.round(haversineKm(here, o.pickup)) : null;
  const onMyTrip = dc.trips.some((t) => matchRoute(t.stops, o.pickup, o.dropoff, r.stopMatchKm, r.roadFactor) !== null);
  const near = distanceToPickupKm !== null && distanceToPickupKm <= d.radius_km;

  const base = { visible: true, requestedToMe, onMyTrip, near, sizeWarning, distanceToPickupKm };
  // the customer's last payment failed: nobody can take the order until they save a working card
  if (o.payment_error) return { ...base, canTake: false, lockReason: 'client_payment' };
  if (o.declared_value_cents > cargoLimitCents({ tier: d.tier, cargoLimitCents: d.cargo_limit_cents }, o.insured, r)) return { ...base, canTake: false, lockReason: 'cargo_limit' };
  if (!requestedToMe && d.tier !== 'pro' && now < new Date(o.pro_until)) return { ...base, canTake: false, lockReason: 'pro_window', opensAt: o.pro_until };
  return { ...base, canTake: true };
}

/** Notify drivers about a new or re-opened order. phase 'pro' = Pro only; 'basic' = the rest. */
export async function dispatchOrder(ctx: Ctx, o: OrderRow, phase: 'pro' | 'basic' | 'all', limit = 500): Promise<number> {
  const drivers = await ctx.db.query<{ user_id: string }>(
    `SELECT user_id FROM drivers WHERE status = 'approved' AND user_id <> $1 AND ($2 = 'all' OR tier::text = $2)`,
    [o.client_id, phase === 'all' ? 'all' : phase],
  );
  const route = `${o.pickup.city} → ${o.dropoff.city}`;
  let sent = 0;
  for (const { user_id } of drivers) {
    if (sent >= limit) break;
    const dc = await loadDriverContext(ctx.db, user_id);
    if (!dc) continue;
    // evaluate as if the Pro window were over, so basic drivers are matched in the 'basic' phase
    const e = evaluate(ctx, { ...o, pro_until: phase === 'pro' ? o.pro_until : new Date(0).toISOString() }, dc);
    // everyone can see every open order; notified are all drivers based in the pickup city,
    // plus drivers nearby right now or with a trip that matches the order
    const r = ctx.cfg.rules;
    const d = dc.driver;
    const inPickupCity = (d.home_city !== null && d.home_city.toLowerCase() === o.pickup.city.toLowerCase())
      || (d.home_lat !== null && d.home_lng !== null && haversineKm({ lat: d.home_lat, lng: d.home_lng }, o.pickup) <= r.cityRadiusKm);
    if (!e.visible || e.lockReason === 'cargo_limit' || e.lockReason === 'client_payment' || (!inPickupCity && !e.near && !e.onMyTrip && !e.requestedToMe)) continue;
    const trip = e.onMyTrip ? dc.trips.find((t) => matchRoute(t.stops, o.pickup, o.dropoff, r.stopMatchKm, r.roadFactor)) : undefined;
    if (trip) {
      // a load on one of the driver's published trips: say which trip, and only once per order
      const ins = await ctx.db.query('INSERT INTO load_matches(order_id, driver_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING order_id', [o.id, user_id]);
      if (!ins.length) continue;
      const tripText = `${trip.stops[0]!.city} → ${trip.stops[trip.stops.length - 1]!.city}`;
      await notify(ctx, user_id, 'new_order_on_trip', { route, price: fmtCad(o.price_cents), number: o.number, trip: tripText }, { orderId: o.id });
    } else {
      await notify(ctx, user_id, phase === 'pro' && dc.driver.tier === 'pro' ? 'new_order_pro' : 'new_order', { route, price: fmtCad(o.price_cents), number: o.number }, { orderId: o.id });
    }
    sent++;
  }
  return sent;
}

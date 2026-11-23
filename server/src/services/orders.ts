// Orders: quote, create, price negotiation, confirmation (card charged),
// pickup → transit → delivery by PIN, cancellations and driver drop-outs.
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { isPgCode, maybeOne, one, PgCode, type Queryable } from '../db/db.js';
import { digits, safeEqual } from '../lib/crypto.js';
import { bad, conflict, forbidden, HttpError, notFound, paymentRequired } from '../lib/errors.js';
import { roadKm, sameCity } from '../lib/geo.js';
import { breakdown, cancelSplit, fmtCad, insuranceCents, suggestPriceCents, SIZES, type Size } from '../lib/pricing.js';
import { normalizePhone } from '../lib/phone.js';
import { provinceTz, windowInZone } from '../lib/tz.js';
import { dispatchOrder, evaluate, loadDriverContext } from './dispatch.js';
import { firstName, orderDto, rating, type DriverRow, type OfferRow, type OrderRow, type UserRow } from './dto.js';
import { notify, smsTo } from './notify.js';
import { payDriver } from './payouts.js';
import { matchTrips } from './trips.js';

export const placeSchema = z.object({
  address: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(80),
  province: z.string().trim().length(2).transform((s) => s.toUpperCase()),
  lat: z.number().min(41).max(84),
  lng: z.number().min(-142).max(-52),
});

const sizeSchema = z.enum(SIZES as [Size, ...Size[]]);
const money = z.number().int().min(0).max(10_000_000);

export const quoteSchema = z.object({
  pickup: placeSchema,
  dropoff: placeSchema,
  size: sizeSchema,
  declaredValueCents: money,
  insured: z.boolean(),
  windowStart: z.string().datetime({ offset: true }).optional(),
  windowEnd: z.string().datetime({ offset: true }).optional(),
  deliveryStart: z.string().datetime({ offset: true }).nullish(),
  deliveryEnd: z.string().datetime({ offset: true }).nullish(),
});

export const createOrderSchema = quoteSchema.extend({
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  description: z.string().trim().max(500).default(''),
  photoKeys: z.array(z.string().max(300)).max(6).default([]),
  priceCents: z.number().int().min(500).max(10_000_000).optional(),
  recipientName: z.string().trim().max(80).optional(),
  recipientPhone: z.string().trim().max(20).optional(),
  tripId: z.string().uuid().optional(),
});

function geometry(ctx: Ctx, p: z.infer<typeof quoteSchema>) {
  const r = ctx.cfg.rules;
  const km = roadKm(p.pickup, p.dropoff, r.roadFactor);
  const intercity = !sameCity(p.pickup, p.dropoff, r.cityRadiusKm);
  return { km, intercity };
}

export async function quote(ctx: Ctx, p: z.infer<typeof quoteSchema>, userId?: string) {
  const { km, intercity } = geometry(ctx, p);
  const suggested = suggestPriceCents(p.size, km, intercity);
  const b = breakdown(suggested, p.insured, p.declaredValueCents, ctx.cfg.rules);
  const trips = intercity
    ? await matchTrips(ctx, {
        pickup: p.pickup, dropoff: p.dropoff, size: p.size, km, declaredValueCents: p.declaredValueCents, insured: p.insured,
        windowStart: p.windowStart ? new Date(p.windowStart) : undefined, windowEnd: p.windowEnd ? new Date(p.windowEnd) : undefined, excludeDriver: userId,
        deliveryEnd: p.deliveryEnd ? new Date(p.deliveryEnd) : undefined,
      })
    : [];
  return {
    distanceKm: km,
    intercity,
    suggestedPriceCents: suggested,
    insuranceCents: insuranceCents(p.declaredValueCents, ctx.cfg.rules),
    breakdown: b,
    rates: { clientFee: ctx.cfg.rules.clientFeeRate, driverFee: ctx.cfg.rules.driverFeeRate, insurance: ctx.cfg.rules.insuranceRate, insuranceMinCents: ctx.cfg.rules.insuranceMinCents },
    trips,
  };
}

async function getOrder(q: Queryable, id: string, lock = false): Promise<OrderRow> {
  const o = await maybeOne<OrderRow>(q, `SELECT * FROM orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!o) throw notFound('Order not found');
  return o;
}

async function event(q: Queryable, orderId: string, actorId: string | null, type: string, data: Record<string, unknown> = {}) {
  await q.query('INSERT INTO order_events(order_id, actor_id, type, data) VALUES ($1, $2, $3, $4)', [orderId, actorId, type, data]);
}

async function systemMessage(ctx: Ctx, o: OrderRow, text: string) {
  const [m] = await ctx.db.query<{ id: number; created_at: string }>('INSERT INTO messages(order_id, sender_id, body) VALUES ($1, NULL, $2) RETURNING id, created_at', [o.id, text]);
  const msg = { id: m?.id, orderId: o.id, from: 'system', body: text, createdAt: m?.created_at };
  ctx.hub.publish(o.client_id, 'message', msg);
  if (o.driver_id) ctx.hub.publish(o.driver_id, 'message', msg);
}

/** Tell both sides the order changed (they re-fetch it). */
function emit(ctx: Ctx, o: Pick<OrderRow, 'id' | 'client_id' | 'driver_id' | 'status'>, extraDriver?: string | null) {
  const data = { orderId: o.id, status: o.status };
  ctx.hub.publish(o.client_id, 'order', data);
  if (o.driver_id) ctx.hub.publish(o.driver_id, 'order', data);
  if (extraDriver && extraDriver !== o.driver_id) ctx.hub.publish(extraDriver, 'order', data);
}

const windowText = (o: OrderRow) => windowInZone(o.window_start, o.window_end, provinceTz(o.pickup.province));

// ---------------------------------------------------------------- create

export async function createOrder(ctx: Ctx, clientId: string, p: z.infer<typeof createOrderSchema>) {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [clientId]);
  if (!u.name || !u.email || !u.terms_accepted_at) throw bad('profile_incomplete', 'Add your name and email and accept the terms first');
  if (!u.payment_method_id || !u.stripe_customer_id) throw paymentRequired('card_required', 'Add a card first');
  const now = ctx.now();
  const ws = new Date(p.windowStart);
  const we = new Date(p.windowEnd);
  if (we <= ws) throw bad('bad_window', 'The loading window must end after it starts');
  if (we.getTime() < now.getTime() + 15 * 60_000) throw bad('bad_window', 'The loading window has already passed');
  if (ws.getTime() > now.getTime() + 30 * 86_400_000) throw bad('bad_window', 'Orders can be placed up to 30 days ahead');
  if (we.getTime() > now.getTime() + 31 * 86_400_000) throw bad('bad_window', 'The loading window must end within 30 days');
  const ds = p.deliveryStart ? new Date(p.deliveryStart) : null;
  const de = p.deliveryEnd ? new Date(p.deliveryEnd) : null;
  if (ds && !de) throw bad('bad_delivery', 'Add the "deliver no later than" date');
  if (de && de <= ws) throw bad('bad_delivery', 'The delivery deadline must be after loading starts');
  if (de && ds && ds >= de) throw bad('bad_delivery', 'Delivery must start before the deadline');
  if (ds && ds < ws) throw bad('bad_delivery', 'Delivery cannot start before loading');
  if (de && de.getTime() > now.getTime() + 61 * 86_400_000) throw bad('bad_delivery', 'The delivery deadline must be within 60 days');
  for (const k of p.photoKeys) if (!k.startsWith(`u/${clientId}/`)) throw forbidden('A photo does not belong to you');
  let recipientPhone: string | null = null;
  if (p.recipientPhone) {
    recipientPhone = normalizePhone(p.recipientPhone);
    if (!recipientPhone) throw bad('invalid_phone', "The recipient's phone number is not valid");
  }
  const { km, intercity } = geometry(ctx, p);
  const r = ctx.cfg.rules;
  let price = p.priceCents ?? suggestPriceCents(p.size, km, intercity);
  let requestedDriver: string | null = null;
  let requestExpires: Date | null = null;
  if (p.tripId) {
    const options = await matchTrips(ctx, { pickup: p.pickup, dropoff: p.dropoff, size: p.size, km, declaredValueCents: p.declaredValueCents, insured: p.insured, excludeDriver: clientId, deliveryEnd: de ?? undefined });
    const opt = options.find((t) => t.tripId === p.tripId);
    if (!opt) throw bad('trip_unavailable', 'This trip does not fit your order any more');
    const trip = await one<{ driver_id: string }>(ctx.db, 'SELECT driver_id FROM trips WHERE id = $1', [p.tripId]);
    price = opt.priceCents;
    requestedDriver = trip.driver_id;
    requestExpires = new Date(Math.min(now.getTime() + r.tripRequestTimeoutSec * 1000, we.getTime()));
  }
  const proUntil = new Date(now.getTime() + (intercity ? r.proWindowIntercitySec : r.proWindowCitySec) * 1000);
  const o = await one<OrderRow>(
    ctx.db,
    `INSERT INTO orders(client_id, trip_id, requested_driver_id, request_expires_at, pickup, dropoff, intercity, distance_km, size, description, photo_keys,
       declared_value_cents, insured, insurance_cents, window_start, window_end, recipient_name, recipient_phone, price_cents, pro_until, pin, delivery_start, delivery_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [clientId, p.tripId ?? null, requestedDriver, requestExpires?.toISOString() ?? null, p.pickup, p.dropoff, intercity, km, p.size, p.description, p.photoKeys,
      p.declaredValueCents, p.insured, p.insured ? insuranceCents(p.declaredValueCents, r) : 0, ws.toISOString(), we.toISOString(),
      p.recipientName ?? null, recipientPhone, price, proUntil.toISOString(), digits(4), ds?.toISOString() ?? null, de?.toISOString() ?? null],
  );
  await event(ctx.db, o.id, clientId, 'created', { priceCents: price, tripId: p.tripId ?? null });
  await notify(ctx, clientId, 'order_created', { number: o.number, route: `${o.pickup.city} → ${o.dropoff.city}`, window: windowText(o) }, { orderId: o.id });
  if (requestedDriver) {
    await notify(ctx, requestedDriver, 'trip_request', { route: `${o.pickup.city} → ${o.dropoff.city}`, price: fmtCad(price), number: o.number }, { orderId: o.id });
  } else {
    await dispatchOrder(ctx, o, 'pro');
  }
  return clientOrder(ctx, clientId, o.id);
}

// ---------------------------------------------------------------- read

async function participants(ctx: Ctx, o: OrderRow) {
  let driver = null;
  if (o.driver_id) {
    const d = await maybeOne<{ name: string | null; rating_sum: number; rating_count: number; tier: string; completed_jobs: number; make: string | null; model: string | null }>(
      ctx.db,
      `SELECT u.name, u.rating_sum, u.rating_count, d.tier, d.completed_jobs, v.make, v.model
       FROM drivers d JOIN users u ON u.id = d.user_id
       LEFT JOIN LATERAL (SELECT make, model FROM vehicles WHERE driver_id = d.user_id AND active ORDER BY created_at LIMIT 1) v ON true
       WHERE d.user_id = $1`,
      [o.driver_id],
    );
    if (d) driver = { name: firstName(d.name), rating: rating(d.rating_sum, d.rating_count), tier: d.tier, vehicle: d.make ? `${d.make} ${d.model}` : null, completedJobs: d.completed_jobs };
  }
  const c = await one<{ name: string | null; rating_sum: number; rating_count: number }>(ctx.db, 'SELECT name, rating_sum, rating_count FROM users WHERE id = $1', [o.client_id]);
  const photos = await ctx.db.query<{ stage: string; file_key: string; created_at: string }>('SELECT stage, file_key, created_at FROM order_photos WHERE order_id = $1 ORDER BY created_at', [o.id]);
  return {
    driver,
    client: { name: firstName(c.name), rating: rating(c.rating_sum, c.rating_count) },
    photos: photos.map((p) => ({ stage: p.stage, url: ctx.storage.url(p.file_key), createdAt: p.created_at })),
  };
}

export async function clientOrder(ctx: Ctx, clientId: string, orderId: string) {
  const o = await getOrder(ctx.db, orderId);
  if (o.client_id !== clientId) throw notFound('Order not found');
  const offers = await ctx.db.query<OfferRow>('SELECT * FROM offers WHERE order_id = $1 ORDER BY created_at', [o.id]);
  return orderDto(o, 'client', { offers, ...(await participants(ctx, o)), urls: (k) => ctx.storage.url(k) });
}

export async function clientOrders(ctx: Ctx, clientId: string) {
  const rows = await ctx.db.query<OrderRow>('SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100', [clientId]);
  const offers = rows.length ? await ctx.db.query<OfferRow>('SELECT * FROM offers WHERE order_id = ANY($1::uuid[]) ORDER BY created_at', [rows.map((r) => r.id)]) : [];
  return rows.map((o) => orderDto(o, 'client', { offers: offers.filter((f) => f.order_id === o.id), urls: (k) => ctx.storage.url(k) }));
}

export async function driverOrder(ctx: Ctx, driverId: string, orderId: string) {
  const o = await getOrder(ctx.db, orderId);
  const offers = await ctx.db.query<OfferRow>('SELECT * FROM offers WHERE order_id = $1 AND driver_id = $2 ORDER BY created_at', [o.id, driverId]);
  if (o.driver_id === driverId) return { ...orderDto(o, 'driver', { offers, ...(await participants(ctx, o)), urls: (k) => ctx.storage.url(k) }), eligibility: null };
  const dc = await loadDriverContext(ctx.db, driverId);
  if (!dc) throw notFound('Order not found');
  const e = evaluate(ctx, o, dc);
  if (!e.visible) throw notFound('Order not found');
  const p = await participants(ctx, o);
  return { ...orderDto(o, 'prospect', { offers, client: p.client, urls: (k) => ctx.storage.url(k) }), eligibility: e };
}

/** Open orders a driver can see, best first. */
export async function driverFeed(ctx: Ctx, driverId: string) {
  const dc = await loadDriverContext(ctx.db, driverId);
  if (!dc || dc.driver.status !== 'approved') return { status: dc?.driver.status ?? 'none', items: [] };
  const rows = await ctx.db.query<OrderRow>(
    `SELECT * FROM orders WHERE status = 'open' AND window_end > now() AND client_id <> $1 ORDER BY created_at DESC LIMIT 500`,
    [driverId],
  );
  const offers = rows.length ? await ctx.db.query<OfferRow>('SELECT * FROM offers WHERE driver_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY created_at', [driverId, rows.map((r) => r.id)]) : [];
  const items = rows
    .map((o) => ({ o, e: evaluate(ctx, o, dc) }))
    .filter((x) => x.e.visible)
    .sort((a, b) => Number(b.e.requestedToMe) - Number(a.e.requestedToMe) || Number(b.e.onMyTrip) - Number(a.e.onMyTrip) || Number(b.e.near) - Number(a.e.near) || (a.e.distanceToPickupKm ?? 1e9) - (b.e.distanceToPickupKm ?? 1e9))
    .slice(0, 300)
    .map(({ o, e }) => ({ ...orderDto(o, 'prospect', { offers: offers.filter((f) => f.order_id === o.id), urls: (k) => ctx.storage.url(k) }), eligibility: e }));
  return { status: dc.driver.status, tier: dc.driver.tier, items };
}

export async function driverJobs(ctx: Ctx, driverId: string, scope: 'active' | 'history') {
  const rows = await ctx.db.query<OrderRow>(
    scope === 'active'
      ? `SELECT * FROM orders WHERE driver_id = $1 AND status IN ('agreed','picked_up','in_transit') ORDER BY window_start`
      : `SELECT * FROM orders WHERE driver_id = $1 AND status IN ('delivered','cancelled') ORDER BY updated_at DESC LIMIT 100`,
    [driverId],
  );
  return rows.map((o) => orderDto(o, 'driver', { urls: (k) => ctx.storage.url(k) }));
}

// ---------------------------------------------------------------- negotiation & confirmation

async function requireEligible(ctx: Ctx, q: Queryable, o: OrderRow, driverId: string) {
  const dc = await loadDriverContext(q, driverId);
  if (!dc) throw forbidden('Register as a driver first');
  if (dc.driver.status !== 'approved') throw forbidden('Your driver account is not active');
  const e = evaluate(ctx, o, dc);
  if (!e.visible) throw notFound('Order not found');
  if (!e.canTake) {
    const msg = e.lockReason === 'pro_window' ? 'Pro drivers see this order first'
      : e.lockReason === 'client_payment' ? "The customer's payment failed; the order can be taken once they add a working card"
      : 'The cargo value is above your insurance limit';
    throw conflict(e.lockReason ?? 'locked', msg);
  }
  return dc;
}

/** Confirm the order with a driver at `amountCents` and charge the customer's card. */
async function agree(ctx: Ctx, orderId: string, driverId: string, amountCents: number, actorId: string, acceptedOfferId: string | null) {
  const o = await ctx.db.tx(async (q) => {
    const cur = await getOrder(q, orderId, true);
    if (cur.status !== 'open') throw conflict('order_taken', 'This order has already been taken');
    await requireEligible(ctx, q, cur, driverId);
    const b = breakdown(amountCents, cur.insured, cur.declared_value_cents, ctx.cfg.rules);
    const updated = await one<OrderRow>(
      q,
      `UPDATE orders SET status = 'agreed', driver_id = $2, agreed_cents = $3, client_fee_cents = $4, driver_fee_cents = $5, charged_cents = $6,
         requested_driver_id = NULL, request_expires_at = NULL, payment_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, driverId, amountCents, b.clientFeeCents, b.driverFeeCents, b.driverPriceCents + b.clientFeeCents + cur.insurance_cents],
    );
    await q.query(`UPDATE offers SET status = CASE WHEN id = $2 THEN 'accepted'::offer_status ELSE 'expired'::offer_status END WHERE order_id = $1 AND (status = 'pending' OR id = $2)`, [orderId, acceptedOfferId]);
    await event(q, orderId, actorId, 'agreed', { driverId, amountCents });
    return updated;
  });

  const client = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [o.client_id]);
  const res = await ctx.payments.charge({
    customerId: client.stripe_customer_id ?? '',
    paymentMethodId: client.payment_method_id ?? '',
    amountCents: o.charged_cents ?? 0,
    orderId: o.id,
    orderNumber: o.number,
    idempotencyKey: `charge-${o.id}-${o.updated_at}`,
  });
  if (!res.ok) {
    await ctx.db.tx(async (q) => {
      await q.query(
        `UPDATE orders SET status = 'open', driver_id = NULL, agreed_cents = NULL, client_fee_cents = NULL, driver_fee_cents = NULL, charged_cents = NULL,
           payment_error = $3, pro_until = LEAST(pro_until, now()), updated_at = now()
         WHERE id = $1 AND driver_id = $2 AND status = 'agreed'`,
        [o.id, driverId, res.error],
      );
      await q.query(`UPDATE offers SET status = 'expired' WHERE order_id = $1 AND status = 'accepted'`, [o.id]);
      await event(q, o.id, null, 'payment_failed', { error: res.error, paymentIntentId: res.paymentIntentId ?? null });
    });
    await notify(ctx, o.client_id, 'payment_failed', { number: o.number, amount: fmtCad(o.charged_cents ?? 0), reason_code: res.error }, { orderId: o.id });
    if (actorId !== driverId) await notify(ctx, driverId, 'payment_failed_driver', { number: o.number }, { orderId: o.id });
    emit(ctx, { ...o, status: 'open', driver_id: null }, driverId);
    throw paymentRequired('payment_failed', "The customer's payment did not go through. The order is back in the list and we have told the customer");
  }
  await ctx.db.query(`UPDATE orders SET payment_intent_id = $2, charge_id = $3, charged_at = now() WHERE id = $1`, [o.id, res.paymentIntentId, res.chargeId]);
  await event(ctx.db, o.id, null, 'charged', { amountCents: o.charged_cents, paymentIntentId: res.paymentIntentId });
  const drv = await one<{ name: string | null }>(ctx.db, 'SELECT name FROM users WHERE id = $1', [driverId]);
  await notify(ctx, o.client_id, 'order_confirmed', { number: o.number, driver: firstName(drv.name) ?? '', price: fmtCad(o.charged_cents ?? 0) }, { orderId: o.id });
  if (actorId !== driverId) await notify(ctx, driverId, 'job_confirmed', { number: o.number, route: `${o.pickup.city} → ${o.dropoff.city}`, window: windowText(o) }, { orderId: o.id });
  await systemMessage(ctx, o, `Price agreed: ${fmtCad(amountCents)}`);
  emit(ctx, o);
  return o;
}

export async function takeOrder(ctx: Ctx, driverId: string, orderId: string) {
  const o = await getOrder(ctx.db, orderId);
  await agree(ctx, orderId, driverId, o.price_cents, driverId, null);
  return driverOrder(ctx, driverId, orderId);
}

export async function driverOffer(ctx: Ctx, driverId: string, orderId: string, amountCents: number) {
  const o = await getOrder(ctx.db, orderId);
  await requireEligible(ctx, ctx.db, o, driverId);
  if (o.requested_driver_id === driverId) throw conflict('fixed_price', 'Trip bookings have a fixed price. Confirm or decline');
  if (amountCents === o.price_cents) throw bad('same_price', 'To take the order at this price, use Take');
  if (amountCents > o.price_cents * 3 || amountCents < 500) throw bad('price_out_of_range', 'This price is out of range');
  try {
    await ctx.db.query('INSERT INTO offers(order_id, driver_id, by, amount_cents) VALUES ($1, $2, $3, $4)', [orderId, driverId, 'driver', amountCents]);
  } catch (e) {
    if (isPgCode(e, PgCode.uniqueViolation)) throw conflict('offer_used', 'You have already offered a price for this order');
    throw e;
  }
  await event(ctx.db, orderId, driverId, 'driver_offer', { amountCents });
  const drv = await one<{ name: string | null }>(ctx.db, 'SELECT name FROM users WHERE id = $1', [driverId]);
  await notify(ctx, o.client_id, 'offer_from_driver', { driver: firstName(drv.name) ?? '', price: fmtCad(amountCents), number: o.number }, { orderId });
  emit(ctx, o);
  return driverOrder(ctx, driverId, orderId);
}

async function getOffer(q: Queryable, orderId: string, offerId: string): Promise<OfferRow> {
  const f = await maybeOne<OfferRow>(q, 'SELECT * FROM offers WHERE id = $1 AND order_id = $2', [offerId, orderId]);
  if (!f) throw notFound('Offer not found');
  return f;
}

export async function clientRespond(ctx: Ctx, clientId: string, orderId: string, offerId: string, action: 'accept' | 'decline' | 'counter', counterCents?: number) {
  const o = await getOrder(ctx.db, orderId);
  if (o.client_id !== clientId) throw notFound('Order not found');
  if (o.status !== 'open') throw conflict('order_not_open', 'This order is no longer open');
  const f = await getOffer(ctx.db, orderId, offerId);
  if (f.by !== 'driver' || f.status !== 'pending') throw conflict('offer_closed', 'This offer is no longer active');
  if (action === 'accept') {
    await agree(ctx, orderId, f.driver_id, f.amount_cents, clientId, f.id);
    return clientOrder(ctx, clientId, orderId);
  }
  if (action === 'decline') {
    await ctx.db.query(`UPDATE offers SET status = 'declined' WHERE id = $1`, [f.id]);
    await notify(ctx, f.driver_id, 'offer_declined', { number: o.number, price: fmtCad(f.amount_cents) }, { orderId });
    emit(ctx, o, f.driver_id);
    return clientOrder(ctx, clientId, orderId);
  }
  if (!counterCents || counterCents < 500) throw bad('price_out_of_range', 'Enter a price of at least $5');
  try {
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE offers SET status = 'declined' WHERE id = $1`, [f.id]);
      await q.query('INSERT INTO offers(order_id, driver_id, by, amount_cents) VALUES ($1, $2, $3, $4)', [orderId, f.driver_id, 'client', counterCents]);
    });
  } catch (e) {
    if (isPgCode(e, PgCode.uniqueViolation)) throw conflict('offer_used', 'You have already made a counter-offer to this driver');
    throw e;
  }
  await event(ctx.db, orderId, clientId, 'client_counter', { driverId: f.driver_id, amountCents: counterCents });
  await notify(ctx, f.driver_id, 'counter_from_client', { price: fmtCad(counterCents), number: o.number }, { orderId });
  emit(ctx, o, f.driver_id);
  return clientOrder(ctx, clientId, orderId);
}

export async function driverRespond(ctx: Ctx, driverId: string, orderId: string, action: 'accept' | 'decline') {
  const o = await getOrder(ctx.db, orderId);
  const [f] = await ctx.db.query<OfferRow>(`SELECT * FROM offers WHERE order_id = $1 AND driver_id = $2 AND by = 'client' AND status = 'pending'`, [orderId, driverId]);
  if (!f) throw notFound('No counter-offer to answer');
  if (action === 'accept') {
    await agree(ctx, orderId, driverId, f.amount_cents, driverId, f.id);
  } else {
    await ctx.db.query(`UPDATE offers SET status = 'declined' WHERE id = $1`, [f.id]);
    await notify(ctx, o.client_id, 'offer_declined', { number: o.number, price: fmtCad(f.amount_cents) }, { orderId });
    emit(ctx, o);
  }
  return driverOrder(ctx, driverId, orderId);
}

/** A driver declines a booking on their trip; the order opens to everyone. */
export async function declineRequest(ctx: Ctx, driverId: string, orderId: string) {
  const rows = await ctx.db.query<OrderRow>(
    `UPDATE orders SET requested_driver_id = NULL, request_expires_at = NULL, pro_until = now(), updated_at = now()
     WHERE id = $1 AND requested_driver_id = $2 AND status = 'open' RETURNING *`,
    [orderId, driverId],
  );
  const o = rows[0];
  if (!o) throw notFound('No booking to decline');
  await event(ctx.db, orderId, driverId, 'request_declined');
  await notify(ctx, o.client_id, 'trip_request_expired', { number: o.number }, { orderId });
  await ctx.db.query('UPDATE orders SET broadcast_at = now() WHERE id = $1', [orderId]);
  await dispatchOrder(ctx, o, 'all');
  emit(ctx, o);
}

// ---------------------------------------------------------------- the job

async function myJob(q: Queryable, driverId: string, orderId: string, lock = true): Promise<OrderRow> {
  const o = await getOrder(q, orderId, lock);
  if (o.driver_id !== driverId) throw notFound('Order not found');
  return o;
}

export async function enRoute(ctx: Ctx, driverId: string, orderId: string) {
  const o = await ctx.db.tx(async (q) => {
    const cur = await myJob(q, driverId, orderId);
    if (cur.status !== 'agreed') throw conflict('bad_status', 'You can only head out to an order that is not picked up yet');
    const u = await one<OrderRow>(q, `UPDATE orders SET en_route_at = coalesce(en_route_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [orderId]);
    await event(q, orderId, driverId, 'en_route');
    return u;
  });
  const drv = await one<{ name: string | null }>(ctx.db, 'SELECT name FROM users WHERE id = $1', [driverId]);
  await notify(ctx, o.client_id, 'en_route', { number: o.number, driver: firstName(drv.name) ?? '' }, { orderId });
  emit(ctx, o);
  return driverOrder(ctx, driverId, orderId);
}

export const photosSchema = z.object({
  photoKeys: z.array(z.string().max(300)).min(1).max(10),
  lat: z.number().optional(),
  lng: z.number().optional(),
  note: z.string().max(300).optional(),
});

export async function pickUp(ctx: Ctx, driverId: string, orderId: string, p: z.infer<typeof photosSchema>) {
  for (const k of p.photoKeys) if (!k.startsWith(`u/${driverId}/`)) throw forbidden('A photo does not belong to you');
  const o = await ctx.db.tx(async (q) => {
    const cur = await myJob(q, driverId, orderId);
    if (cur.status !== 'agreed') throw conflict('bad_status', 'This order cannot be picked up now');
    const u = await one<OrderRow>(q, `UPDATE orders SET status = 'picked_up', picked_up_at = now(), en_route_at = coalesce(en_route_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [orderId]);
    for (const k of p.photoKeys) await q.query('INSERT INTO order_photos(order_id, stage, file_key, lat, lng) VALUES ($1, $2, $3, $4, $5)', [orderId, 'pickup', k, p.lat ?? null, p.lng ?? null]);
    await event(q, orderId, driverId, 'picked_up', { photos: p.photoKeys.length, note: p.note ?? null });
    return u;
  });
  await notify(ctx, o.client_id, 'picked_up', { number: o.number }, { orderId });
  if (p.note) await systemMessage(ctx, o, `Pickup note: ${p.note}`);
  emit(ctx, o);
  return driverOrder(ctx, driverId, orderId);
}

export async function depart(ctx: Ctx, driverId: string, orderId: string) {
  const o = await ctx.db.tx(async (q) => {
    const cur = await myJob(q, driverId, orderId);
    if (cur.status !== 'picked_up') throw conflict('bad_status', 'Pick up the cargo first');
    const u = await one<OrderRow>(q, `UPDATE orders SET status = 'in_transit', departed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [orderId]);
    await event(q, orderId, driverId, 'in_transit');
    return u;
  });
  await notify(ctx, o.client_id, 'in_transit', { number: o.number, city: o.dropoff.city }, { orderId });
  if (o.recipient_phone && o.pin) {
    const c = await one<{ name: string | null; lang: string }>(ctx.db, 'SELECT name, lang FROM users WHERE id = $1', [o.client_id]);
    await smsTo(ctx, o.recipient_phone, 'recipient_in_transit', c.lang, { client: firstName(c.name) ?? '', pin: o.pin });
  }
  emit(ctx, o);
  return driverOrder(ctx, driverId, orderId);
}

export const deliverSchema = z.object({ pin: z.string().regex(/^\d{4}$/), photoKeys: z.array(z.string().max(300)).max(10).default([]), lat: z.number().optional(), lng: z.number().optional() });

export async function deliver(ctx: Ctx, driverId: string, orderId: string, p: z.infer<typeof deliverSchema>) {
  for (const k of p.photoKeys) if (!k.startsWith(`u/${driverId}/`)) throw forbidden('A photo does not belong to you');
  const result = await ctx.db.tx(async (q) => {
    const cur = await myJob(q, driverId, orderId);
    if (cur.status !== 'picked_up' && cur.status !== 'in_transit') throw conflict('bad_status', 'This order is not on the way');
    if (cur.pin_attempts >= 10) throw new HttpError(423, 'pin_locked', 'Too many wrong PINs. Contact support');
    if (!cur.pin || !safeEqual(cur.pin, p.pin)) {
      await q.query('UPDATE orders SET pin_attempts = pin_attempts + 1 WHERE id = $1', [orderId]);
      return { ok: false as const, left: 9 - cur.pin_attempts };
    }
    const u = await one<OrderRow>(q, `UPDATE orders SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [orderId]);
    for (const k of p.photoKeys) await q.query('INSERT INTO order_photos(order_id, stage, file_key, lat, lng) VALUES ($1, $2, $3, $4, $5)', [orderId, 'delivery', k, p.lat ?? null, p.lng ?? null]);
    await q.query('UPDATE drivers SET completed_jobs = completed_jobs + 1 WHERE user_id = $1', [driverId]);
    await q.query(`UPDATE trips SET status = 'completed' WHERE id = $1 AND depart_at < now() - interval '12 hours'`, [u.trip_id]);
    await event(q, orderId, driverId, 'delivered');
    return { ok: true as const, order: u };
  });
  if (!result.ok) throw bad('wrong_pin', 'The PIN does not match', { attemptsLeft: result.left });
  const o = result.order;
  await notify(ctx, o.client_id, 'delivered', { number: o.number }, { orderId });
  await systemMessage(ctx, o, 'Delivered with PIN');
  await payDriver(ctx, orderId, 'delivery');
  emit(ctx, o);
  return driverOrder(ctx, driverId, orderId);
}

/** Driver backs out before pickup: customer is refunded in full, order reopens to everyone. */
export async function dropJob(ctx: Ctx, driverId: string, orderId: string, reason: string) {
  const o = await ctx.db.tx(async (q) => {
    const cur = await myJob(q, driverId, orderId);
    if (cur.status !== 'agreed') throw conflict('bad_status', 'After pickup the order cannot be dropped. Open a dispute instead');
    await event(q, orderId, driverId, 'driver_dropped', { reason, paymentIntentId: cur.payment_intent_id, chargedCents: cur.charged_cents });
    return cur;
  });
  if (o.payment_intent_id && o.charged_cents) {
    await ctx.payments.refund({ paymentIntentId: o.payment_intent_id, amountCents: o.charged_cents, idempotencyKey: `refund-drop-${o.id}-${o.payment_intent_id}` });
  }
  const reopened = await one<OrderRow>(
    ctx.db,
    `UPDATE orders SET status = 'open', driver_id = NULL, agreed_cents = NULL, client_fee_cents = NULL, driver_fee_cents = NULL, charged_cents = NULL,
       payment_intent_id = NULL, charge_id = NULL, charged_at = NULL, en_route_at = NULL, trip_id = NULL, pro_until = now(), broadcast_at = now(),
       driver_lat = NULL, driver_lng = NULL, driver_pos_at = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [orderId],
  );
  await notify(ctx, o.client_id, 'driver_dropped', { number: o.number }, { orderId });
  const [{ n } = { n: 0 }] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM order_events WHERE actor_id = $1 AND type = 'driver_dropped' AND created_at > now() - interval '30 days'`, [driverId]);
  if (n >= ctx.cfg.rules.maxDriverDrops30d) {
    await ctx.db.query(`UPDATE drivers SET status = 'paused', paused_reason = 'too_many_drops' WHERE user_id = $1`, [driverId]);
    await notify(ctx, driverId, 'paused_drops', { n });
  }
  await dispatchOrder(ctx, reopened, 'all');
  emit(ctx, reopened, driverId);
}

// ---------------------------------------------------------------- cancellation by the customer

export async function cancelPreview(ctx: Ctx, clientId: string, orderId: string) {
  const o = await getOrder(ctx.db, orderId);
  if (o.client_id !== clientId) throw notFound('Order not found');
  if (o.status === 'picked_up' || o.status === 'in_transit') throw conflict('too_late', 'The cargo is already with the driver. Open a dispute instead');
  if (o.status === 'delivered' || o.status === 'cancelled') throw conflict('order_closed', 'This order is closed');
  return splitFor(ctx, o);
}

function splitFor(ctx: Ctx, o: OrderRow, noShow = false) {
  const s = cancelSplit(
    { status: o.status, agreedCents: o.agreed_cents, clientFeeCents: o.client_fee_cents, insuranceCents: o.insurance_cents, chargedCents: o.charged_cents, windowStart: o.window_start },
    ctx.now(),
    ctx.cfg.rules,
    { noShow, driverSetOff: o.en_route_at !== null },
  );
  return { ...s, chargedCents: o.charged_cents ?? 0 };
}

export async function cancelByClient(ctx: Ctx, clientId: string, orderId: string, reason?: string) {
  const preview = await cancelPreview(ctx, clientId, orderId);
  void preview;
  return applyCancel(ctx, orderId, 'client', clientId, reason ?? null, false);
}

export async function applyCancel(ctx: Ctx, orderId: string, by: 'client' | 'admin' | 'system', actorId: string | null, reason: string | null, noShow: boolean) {
  const { o, s } = await ctx.db.tx(async (q) => {
    const cur = await getOrder(q, orderId, true);
    if (cur.status === 'delivered' || cur.status === 'cancelled') throw conflict('order_closed', 'This order is closed');
    if (!noShow && (cur.status === 'picked_up' || cur.status === 'in_transit')) throw conflict('too_late', 'The cargo is already with the driver');
    const split = splitFor(ctx, cur, noShow);
    const u = await one<OrderRow>(
      q,
      `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
         refund_cents = $4, driver_comp_cents = $5, platform_comp_cents = $6, requested_driver_id = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, by, reason, split.refundCents, split.driverCents, split.platformCents],
    );
    await q.query(`UPDATE offers SET status = 'expired' WHERE order_id = $1 AND status = 'pending'`, [orderId]);
    await event(q, orderId, actorId, 'cancelled', { by, ...split });
    return { o: u, s: split };
  });
  if (o.payment_intent_id && s.refundCents > 0) {
    await ctx.payments.refund({ paymentIntentId: o.payment_intent_id, amountCents: s.refundCents, idempotencyKey: `refund-cancel-${o.id}` });
  }
  if (o.driver_id) {
    if (s.driverCents > 0) await payDriver(ctx, orderId, 'cancel_comp');
    await notify(ctx, o.driver_id, 'cancelled_by_client', { number: o.number, amount: fmtCad(Math.round(s.driverCents)) }, { orderId });
  }
  if (by !== 'client' || s.tier !== 'free') await notify(ctx, o.client_id, 'cancelled_refund', { number: o.number, amount: fmtCad(s.refundCents) }, { orderId, sms: false });
  emit(ctx, o);
  return { ...s, status: o.status };
}

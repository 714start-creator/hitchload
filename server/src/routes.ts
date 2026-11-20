// Every HTTP endpoint. All JSON; money in cents (CAD); times ISO-8601.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './ctx.js';
import { bad, HttpError } from './lib/errors.js';
import { parse, RateLimiter, RawResponse, type Req, Router } from './http/router.js';
import * as admin from './services/admin.js';
import * as drivers from './services/drivers.js';
import * as matching from './services/matching.js';
import * as orders from './services/orders.js';
import { driverEarnings } from './services/payouts.js';
import * as support from './services/support.js';
import * as trips from './services/trips.js';
import * as users from './services/users.js';
import { handleStripeEvent } from './services/webhooks.js';

const uid = (r: Req) => r.user!.id;
const id = (r: Req, k = 'id') => {
  const v = r.params[k] ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw bad('invalid_id');
  return v;
};

const UPLOAD_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export function buildRouter(ctx: Ctx): Router {
  const r = new Router({ authenticate: (t) => users.authenticate(ctx, t), corsOrigins: ctx.cfg.corsOrigins, log: ctx.log });
  const otpPhoneLimit = new RateLimiter(5, 15 * 60_000);
  const otpIpLimit = new RateLimiter(30, 15 * 60_000);

  // ---------------------------------------------------------------- public
  r.get('/health', async () => ({ ok: true, payments: ctx.payments.kind, sms: ctx.sms.kind, push: ctx.push.kind, storage: ctx.storage.kind }), { access: 'public' });

  r.get('/v1/config', async () => ({
    stripePublishableKey: ctx.cfg.stripe.publishableKey,
    rules: {
      clientFeeRate: ctx.cfg.rules.clientFeeRate,
      driverFeeRate: ctx.cfg.rules.driverFeeRate,
      insuranceRate: ctx.cfg.rules.insuranceRate,
      insuranceMinCents: ctx.cfg.rules.insuranceMinCents,
      basicCargoLimitCents: ctx.cfg.rules.basicCargoLimitCents,
      basicInsuredCargoLimitCents: ctx.cfg.rules.basicInsuredCargoLimitCents,
      cancelLateHours: ctx.cfg.rules.cancelLateHours,
      cancelEarly: { driver: ctx.cfg.rules.cancelEarlyDriverRate, platform: ctx.cfg.rules.cancelEarlyPlatformRate },
      cancelLate: { driver: ctx.cfg.rules.cancelLateDriverRate, platform: ctx.cfg.rules.cancelLatePlatformRate },
    },
  }), { access: 'public' });

  r.get('/v1/cities', async () => trips.cityList(), { access: 'public' });

  r.post('/v1/auth/otp/start', async (req) => {
    const p = parse(z.object({ phone: z.string().max(30) }), req.body);
    if (!otpIpLimit.check(req.ip) || !otpPhoneLimit.check(p.phone.replace(/\D/g, ''))) throw new HttpError(429, 'too_many_requests', 'Too many codes requested. Try again in 15 minutes');
    return users.startOtp(ctx, p.phone);
  }, { access: 'public' });

  r.post('/v1/auth/otp/verify', async (req) => {
    const p = parse(z.object({ phone: z.string().max(30), code: z.string().min(4).max(8) }), req.body);
    if (!otpIpLimit.check('v:' + req.ip)) throw new HttpError(429, 'too_many_requests', 'Too many attempts. Try again later');
    return users.verifyOtp(ctx, p.phone, p.code);
  }, { access: 'public' });

  r.post('/v1/quotes', async (req) => orders.quote(ctx, parse(orders.quoteSchema, req.body), req.user?.id), { access: 'public' });
  r.get('/v1/trips/map', async (req) => trips.tripsMap(ctx, req.query.get('province') ?? undefined), { access: 'public' });

  // public pages of the site: who is driving where, which loads are waiting
  const cityParam = (v: string | null, name: string) => {
    const m = /^(.+),\s*([A-Za-z]{2})$/.exec(v ?? '');
    if (!m) throw bad('invalid_city', `${name}: use "City, PR"`);
    return { city: m[1]!.trim(), province: m[2]!.toUpperCase() };
  };
  r.get('/v1/public/trips', async (req) => {
    const size = req.query.get('size');
    const date = req.query.get('date');
    if (size && !['S', 'M', 'L', 'XL', 'AUTO'].includes(size)) throw bad('invalid_size');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('invalid_date');
    return matching.searchTrips(ctx, { from: cityParam(req.query.get('from'), 'from'), to: cityParam(req.query.get('to'), 'to'), size: (size ?? undefined) as never, date: date ?? undefined, excludeDriver: req.user?.id });
  }, { access: 'public' });
  r.get('/v1/public/loads', async (req) => matching.publicLoads(ctx, { from: req.query.get('from') ?? undefined, to: req.query.get('to') ?? undefined, province: req.query.get('province') ?? undefined }), { access: 'public' });
  r.get('/v1/public/stats', async () => matching.publicStats(ctx), { access: 'public' });
  r.get('/v1/public/site', async () => ({
    brand: ctx.cfg.brand,
    supportEmail: ctx.cfg.supportEmail,
    stripePublishableKey: ctx.cfg.stripe.publishableKey,
    vapidPublicKey: ctx.webPush.publicKey,
    googleMapsKey: ctx.cfg.googleMapsKey ?? null,
    mapTilesUrl: ctx.cfg.mapTilesUrl,
    mapAttribution: ctx.cfg.mapAttribution,
    devCodes: !ctx.cfg.prod,
    fakePayments: ctx.payments.kind === 'fake',
  }), { access: 'public' });

  r.get('/v1/auth/email/verify', async (req) => {
    const to = await users.verifyEmail(ctx, req.query.get('u') ?? '', req.query.get('t') ?? '');
    return new RawResponse(302, { Location: ctx.cfg.publicUrl + to }, '');
  }, { access: 'public' });
  r.get('/v1/alerts/:id/unsubscribe', async (req) => {
    const ok = await matching.unsubscribeAlert(ctx, id(req), req.query.get('s') ?? '');
    return new RawResponse(302, { Location: `${ctx.cfg.publicUrl}/account?alert=${ok ? 'off' : 'invalid'}` }, '');
  }, { access: 'public' });

  r.post('/webhooks/stripe', async (req) => {
    const ev = ctx.payments.parseWebhook(req.raw, req.headers['stripe-signature'] as string | undefined);
    if (!ev) throw bad('invalid_signature');
    return { result: await handleStripeEvent(ctx, ev) };
  }, { access: 'public', rawBody: true });

  // Stripe sends drivers back here after payout setup / identity check
  const returnPage = (done: string) => async () => new RawResponse(302, { Location: `${ctx.cfg.publicUrl}/driver/setup?done=${done}` }, '');
  r.get('/return/payouts', returnPage('payouts'), { access: 'public' });
  r.get('/return/identity', returnPage('identity'), { access: 'public' });

  // ---------------------------------------------------------------- account
  r.get('/v1/me', async (req) => users.getMe(ctx, uid(req)));
  r.patch('/v1/me', async (req) => users.updateProfile(ctx, uid(req), parse(users.profileSchema, req.body)));
  r.post('/v1/me/push-tokens', async (req) => {
    const p = parse(z.object({ token: z.string().max(2000), platform: z.enum(['ios', 'android', 'web']) }), req.body);
    await users.savePushToken(ctx, uid(req), p.token, p.platform);
    return { ok: true };
  });
  r.delete('/v1/me/push-tokens', async (req) => {
    const p = parse(z.object({ token: z.string().max(2000) }), req.body);
    await users.removePushToken(ctx, uid(req), p.token);
    return { ok: true };
  });
  r.post('/v1/me/email/verify', async (req) => users.sendEmailVerification(ctx, uid(req)));
  r.get('/v1/alerts', async (req) => matching.listAlerts(ctx, uid(req)));
  r.post('/v1/alerts', async (req) => matching.createAlert(ctx, uid(req), parse(matching.alertSchema, req.body)));
  r.delete('/v1/alerts/:id', async (req) => {
    await matching.deleteAlert(ctx, uid(req), id(req));
    return { ok: true };
  });
  // development / demo only: with the payment stand-in there is no Stripe form, so save a test card directly
  r.post('/v1/dev/test-card', async (req) => {
    const p = ctx.payments as { kind: string; addCard?: (customerId: string, last4?: string) => void };
    if (ctx.cfg.prod || p.kind !== 'fake' || !p.addCard) throw new HttpError(404, 'not_found');
    const s = await users.startCardSetup(ctx, uid(req));
    const last4 = parse(z.object({ last4: z.string().regex(/^\d{4}$/).optional() }), req.body ?? {}).last4;
    p.addCard(s.customerId, last4);
    return users.syncCard(ctx, uid(req));
  });
  r.post('/v1/me/card/setup', async (req) => users.startCardSetup(ctx, uid(req)));
  r.post('/v1/me/card/sync', async (req) => users.syncCard(ctx, uid(req)));
  r.get('/v1/me/notifications', async (req) => users.listNotifications(ctx, uid(req), req.query.get('before') ? Number(req.query.get('before')) : undefined));
  r.post('/v1/me/notifications/read', async (req) => {
    const p = parse(z.object({ upTo: z.number().int() }), req.body);
    await users.markNotificationsRead(ctx, uid(req), p.upTo);
    return { ok: true };
  });

  r.post('/v1/uploads', async (req) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = UPLOAD_TYPES[type];
    if (!ext) throw bad('unsupported_file', 'Upload a JPEG, PNG, HEIC, WebP or PDF');
    if (req.raw.length < 100) throw bad('empty_file');
    const purpose = req.query.get('purpose') ?? 'misc';
    if (!/^(order|pickup|delivery|document|misc)$/.test(purpose)) throw bad('invalid_purpose');
    const key = `u/${uid(req)}/${purpose}/${randomUUID()}.${ext}`;
    await ctx.storage.put(key, req.raw, type);
    return { key, url: ctx.storage.url(key) };
  }, { rawBody: true, maxBytes: 12_000_000 });

  // ---------------------------------------------------------------- customer orders
  r.post('/v1/orders', async (req) => orders.createOrder(ctx, uid(req), parse(orders.createOrderSchema, req.body)));
  r.get('/v1/orders', async (req) => orders.clientOrders(ctx, uid(req)));
  r.get('/v1/orders/:id', async (req) => orders.clientOrder(ctx, uid(req), id(req)));
  r.post('/v1/orders/:id/offers/:offerId', async (req) => {
    const p = parse(z.object({ action: z.enum(['accept', 'decline', 'counter']), amountCents: z.number().int().optional() }), req.body);
    return orders.clientRespond(ctx, uid(req), id(req), id(req, 'offerId'), p.action, p.amountCents);
  });
  r.post('/v1/orders/:id/request-trip', async (req) => matching.requestTrip(ctx, uid(req), id(req), parse(z.object({ tripId: z.string().uuid() }), req.body).tripId));
  r.get('/v1/orders/:id/cancel', async (req) => orders.cancelPreview(ctx, uid(req), id(req)));
  r.post('/v1/orders/:id/cancel', async (req) => {
    const p = parse(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});
    return orders.cancelByClient(ctx, uid(req), id(req), p.reason);
  });

  // shared by both sides
  r.get('/v1/orders/:id/messages', async (req) => support.listMessages(ctx, uid(req), id(req), req.user!.isAdmin));
  r.post('/v1/orders/:id/messages', async (req) => support.sendMessage(ctx, uid(req), id(req), parse(z.object({ body: z.string() }), req.body).body));
  r.post('/v1/orders/:id/rating', async (req) => support.rate(ctx, uid(req), id(req), parse(support.rateSchema, req.body)));
  r.post('/v1/orders/:id/disputes', async (req) => support.openDispute(ctx, uid(req), id(req), parse(support.disputeSchema, req.body)));

  // ---------------------------------------------------------------- driver
  r.post('/v1/driver', async (req) => drivers.startDriver(ctx, uid(req)));
  r.get('/v1/driver', async (req) => drivers.driverOverview(ctx, uid(req)));
  r.patch('/v1/driver', async (req) => drivers.updateDriverProfile(ctx, uid(req), parse(drivers.driverProfileSchema, req.body)));
  r.post('/v1/driver/vehicles', async (req) => drivers.addVehicle(ctx, uid(req), parse(drivers.vehicleSchema, req.body)));
  r.delete('/v1/driver/vehicles/:id', async (req) => {
    await drivers.removeVehicle(ctx, uid(req), id(req));
    return { ok: true };
  });
  r.post('/v1/driver/documents', async (req) => drivers.addDocument(ctx, uid(req), parse(drivers.documentSchema, req.body)));
  r.post('/v1/driver/tax', async (req) => drivers.saveTaxInfo(ctx, uid(req), parse(drivers.taxSchema, req.body)));
  r.get('/v1/driver/quiz', async (req) => drivers.quizFor(req.user!.lang));
  r.post('/v1/driver/agreement', async (req) => drivers.submitAgreement(ctx, uid(req), parse(z.object({ answers: z.record(z.string(), z.number().int()) }), req.body).answers));
  // with the payment stand-in (development / demo) the Stripe pages are simulated by /v1/dev/stripe-return
  const devStripe = !ctx.cfg.prod && ctx.payments.kind === 'fake';
  r.post('/v1/driver/identity', async (req) => {
    const r1 = await drivers.startIdentity(ctx, uid(req));
    if (!devStripe) return r1;
    const [d] = await ctx.db.query<{ identity_session_id: string }>('SELECT identity_session_id FROM drivers WHERE user_id = $1', [uid(req)]);
    return { ...r1, url: `${ctx.cfg.publicUrl}/v1/dev/stripe-return?kind=identity&s=${encodeURIComponent(d!.identity_session_id)}` };
  });
  r.post('/v1/driver/payouts', async (req) => {
    const r1 = await drivers.startPayouts(ctx, uid(req), req.user!.email, req.user!.phone);
    return devStripe ? { url: `${ctx.cfg.publicUrl}/return/payouts` } : r1;
  });
  r.get('/v1/dev/stripe-return', async (req) => {
    if (!devStripe) throw new HttpError(404, 'not_found');
    const session = req.query.get('s') ?? '';
    const [d] = await ctx.db.query<{ user_id: string }>('SELECT user_id FROM drivers WHERE identity_session_id = $1', [session]);
    if (d) await handleStripeEvent(ctx, { id: 'evt_dev_' + session, type: 'identity.verification_session.verified', data: { object: { id: session, metadata: { user_id: d.user_id } } } } as never);
    return new RawResponse(302, { Location: `${ctx.cfg.publicUrl}/driver/setup?done=identity` }, '');
  }, { access: 'public' });
  r.post('/v1/driver/payouts/refresh', async (req) => drivers.refreshPayouts(ctx, uid(req)));
  r.post('/v1/driver/submit', async (req) => drivers.submitForReview(ctx, uid(req)));
  r.post('/v1/driver/location', async (req) => {
    const p = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }), req.body);
    await drivers.updateLocation(ctx, uid(req), p.lat, p.lng);
    return { ok: true };
  });
  r.get('/v1/driver/earnings', async (req) => driverEarnings(ctx, uid(req)));

  r.get('/v1/driver/trips', async (req) => trips.myTrips(ctx, uid(req)));
  r.post('/v1/driver/trips', async (req) => {
    const t = await trips.createTrip(ctx, uid(req), parse(trips.tripSchema, req.body));
    const [row] = await ctx.db.query<trips.TripRow>('SELECT * FROM trips WHERE id = $1', [t.id]);
    const { shippersNotified } = await matching.onTripCreated(ctx, row!);
    const loads = await matching.tripLoads(ctx, uid(req), t.id);
    return { ...t, matches: { loads: loads.items.length, shippersNotified } };
  });
  r.get('/v1/driver/trips/:id/loads', async (req) => matching.tripLoads(ctx, uid(req), id(req)));
  r.delete('/v1/driver/trips/:id', async (req) => {
    await trips.cancelTrip(ctx, uid(req), id(req));
    return { ok: true };
  });

  r.get('/v1/driver/feed', async (req) => orders.driverFeed(ctx, uid(req)));
  r.get('/v1/driver/jobs', async (req) => orders.driverJobs(ctx, uid(req), req.query.get('scope') === 'history' ? 'history' : 'active'));
  r.get('/v1/driver/orders/:id', async (req) => orders.driverOrder(ctx, uid(req), id(req)));
  r.post('/v1/driver/orders/:id/take', async (req) => orders.takeOrder(ctx, uid(req), id(req)));
  r.post('/v1/driver/orders/:id/offer', async (req) => orders.driverOffer(ctx, uid(req), id(req), parse(z.object({ amountCents: z.number().int() }), req.body).amountCents));
  r.post('/v1/driver/orders/:id/counter', async (req) => orders.driverRespond(ctx, uid(req), id(req), parse(z.object({ action: z.enum(['accept', 'decline']) }), req.body).action));
  r.post('/v1/driver/orders/:id/decline-request', async (req) => {
    await orders.declineRequest(ctx, uid(req), id(req));
    return { ok: true };
  });
  r.post('/v1/driver/orders/:id/en-route', async (req) => orders.enRoute(ctx, uid(req), id(req)));
  r.post('/v1/driver/orders/:id/pickup', async (req) => orders.pickUp(ctx, uid(req), id(req), parse(orders.photosSchema, req.body)));
  r.post('/v1/driver/orders/:id/depart', async (req) => orders.depart(ctx, uid(req), id(req)));
  r.post('/v1/driver/orders/:id/deliver', async (req) => orders.deliver(ctx, uid(req), id(req), parse(orders.deliverSchema, req.body)));
  r.post('/v1/driver/orders/:id/drop', async (req) => {
    const p = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await orders.dropJob(ctx, uid(req), id(req), p.reason);
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin
  const A = { access: 'admin' as const };
  r.get('/v1/admin/stats', async () => admin.adminStats(ctx), A);
  r.get('/v1/admin/drivers', async (req) => drivers.adminListDrivers(ctx, req.query.get('status') ?? undefined), A);
  r.get('/v1/admin/drivers/:id', async (req) => drivers.adminDriverDetail(ctx, id(req)), A);
  r.post('/v1/admin/drivers/:id/decision', async (req) => drivers.decideDriver(ctx, uid(req), id(req), parse(drivers.decisionSchema, req.body)), A);
  r.post('/v1/admin/drivers/:id/approve-all', async (req) => drivers.approveAll(ctx, uid(req), id(req), parse(drivers.approveAllSchema, req.body)), A);
  r.post('/v1/admin/drivers/:id/background', async (req) => drivers.setBackgroundStatus(ctx, uid(req), id(req), parse(z.object({ status: z.enum(['none', 'pending', 'clear', 'failed']) }), req.body).status), A);
  r.post('/v1/admin/documents/:id/review', async (req) => drivers.reviewDocument(ctx, uid(req), id(req), parse(drivers.reviewDocSchema, req.body)), A);
  r.get('/v1/admin/orders', async (req) => admin.adminOrders(ctx, req.query.get('status') ?? undefined, req.query.get('q') ?? undefined), A);
  r.get('/v1/admin/orders/:id', async (req) => admin.adminOrder(ctx, id(req)), A);
  r.get('/v1/admin/disputes', async (req) => admin.adminDisputes(ctx, req.query.get('status') === 'resolved' ? 'resolved' : 'open'), A);
  r.post('/v1/admin/disputes/:id/resolve', async (req) => support.resolveDispute(ctx, uid(req), id(req), parse(support.resolveSchema, req.body)), A);
  r.post('/v1/admin/users/:id/block', async (req) => {
    await admin.setUserBlocked(ctx, uid(req), id(req), parse(z.object({ blocked: z.boolean() }), req.body).blocked);
    return { ok: true };
  }, A);
  r.get('/v1/admin/reports/cra', async (req) => {
    const year = Number(req.query.get('year') ?? new Date().getUTCFullYear() - 1);
    if (!Number.isInteger(year) || year < 2024 || year > 2100) throw bad('invalid_year');
    const body = await admin.craReport(ctx, uid(req), year);
    return new RawResponse(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="cra-platform-report-${year}.csv"` }, body);
  }, A);

  return r;
}

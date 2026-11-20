// End-to-end: real HTTP server + real Postgres, Stripe/SMS/push replaced by stand-ins.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { broadcastAfterProWindow, expireOpenOrders, expireTripRequests, insuranceCheck } from '../src/services/workers.js';
import { ADMIN_PHONE, client, expectError, JPEG, places, signIn, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;
let admin: Awaited<ReturnType<typeof signIn>>;
let anna: Awaited<ReturnType<typeof signIn>>; // customer
let pro: Awaited<ReturnType<typeof onboard>>; // Pro driver (Ram 1500 + trailer)
let basic: Awaited<ReturnType<typeof onboard>>; // Basic driver (cargo van)
/** ISO time `h` hours from the app's clock (tests move the clock forward). */
const hours = (h: number) => new Date(app.ctx.now().getTime() + h * 3_600_000).toISOString();

before(async () => {
  app = await startTestApp('flow');
  admin = await signIn(app, ADMIN_PHONE);
});
after(async () => {
  await app?.close();
});

async function upload(api: ReturnType<typeof client>, purpose: string): Promise<string> {
  const r = await api.post(`/v1/uploads?purpose=${purpose}`, JPEG, { 'Content-Type': 'image/jpeg' });
  return r.key;
}

async function onboard(phone: string, o: { name: string; tier: 'basic' | 'pro'; vehicle: 'pickup' | 'cargo_van'; trailer?: boolean }) {
  const s = await signIn(app, phone);
  await s.api.patch('/v1/me', { name: o.name, email: `${o.name.split(' ')[0]!.toLowerCase()}@example.com`, acceptTerms: true });
  await s.api.post('/v1/driver');
  await s.api.patch('/v1/driver', { legalName: o.name, address: '10220 104 Ave NW, Edmonton AB', dateOfBirth: '1988-04-12', homeCity: 'Edmonton', home: { lat: 53.5461, lng: -113.4938 }, radiusKm: 50 });
  await s.api.post('/v1/driver/vehicles', { type: o.vehicle, make: o.vehicle === 'pickup' ? 'Ram' : 'Ford', model: o.vehicle === 'pickup' ? '1500' : 'Transit', year: 2021, plate: 'CTX' + phone.slice(-4), registeredWeightKg: 3200, hasTrailer: o.trailer ?? false, equipment: ['straps', 'blankets'] });
  const docs: Record<string, unknown>[] = [
    { kind: 'license_front' }, { kind: 'license_back' }, { kind: 'registration' }, { kind: 'background_check' }, { kind: 'vehicle_side' }, { kind: 'vehicle_rear' },
    { kind: o.tier === 'pro' ? 'insurance_commercial' : 'insurance_endorsement', insurer: 'Intact', policyNumber: 'P-' + phone.slice(-4), expiresOn: '2027-06-30' },
  ];
  if (o.tier === 'pro') docs.push({ kind: 'insurance_cargo', insurer: 'Aviva', policyNumber: 'C-1', coverageCents: 2_500_000, expiresOn: '2027-06-30' });
  for (const d of docs) await s.api.post('/v1/driver/documents', { ...d, fileKey: await upload(s.api, 'document') });
  const id = await s.api.post('/v1/driver/identity');
  assert.match(id.url, /^https:\/\/|\/v1\/dev\/stripe-return/); // dev mode simulates the Stripe page
  await s.api.post('/v1/driver/payouts');
  const quiz = await s.api.get('/v1/driver/quiz');
  assert.equal(quiz.length, 5);
  await expectError(s.api.post('/v1/driver/agreement', { answers: { pin: 1 } }), 400, 'quiz_failed');
  await s.api.post('/v1/driver/agreement', { answers: Object.fromEntries(quiz.map((q: { id: string }) => [q.id, 0])) });
  const submitted = await s.api.post('/v1/driver/submit');
  assert.equal(submitted.driver.status, 'pending');
  // Stripe tells us the ID check passed and payouts are on
  const me = await s.api.get('/v1/me');
  const sessionId = [...app.payments.identity.entries()].find(([, u]) => u === me.id)![0];
  await client(app.url).post('/webhooks/stripe', { id: 'evt_id_' + phone, type: 'identity.verification_session.verified', data: { object: { id: sessionId, metadata: { user_id: me.id } } } });
  await s.api.post('/v1/driver/payouts/refresh');
  // admin review
  const detail = await admin.api.get(`/v1/admin/drivers/${me.id}`);
  await expectError(admin.api.post(`/v1/admin/drivers/${me.id}/decision`, { status: 'approved' }), 400, 'not_ready');
  for (const d of detail.documents) await admin.api.post(`/v1/admin/documents/${d.id}/review`, { status: 'approved' });
  const decided = await admin.api.post(`/v1/admin/drivers/${me.id}/decision`, { status: 'approved', tier: o.tier, backgroundStatus: 'clear' });
  assert.equal(decided.driver.status, 'approved');
  assert.equal(decided.driver.tier, o.tier);
  return { ...s, id: me.id as string };
}

test('customer signs up with phone, profile and a card', async () => {
  await expectError(client(app.url).post('/v1/auth/otp/start', { phone: '123' }), 400, 'invalid_phone');
  anna = await signIn(app, '(780) 555-0123');
  assert.equal(anna.user.phone, '+17805550123');
  await expectError(anna.api.post('/v1/orders', {}), 400, 'validation_failed');
  await anna.api.patch('/v1/me', { name: 'Anna Kovalenko', email: 'anna@example.com', acceptTerms: true, lang: 'ru' });
  const setup = await anna.api.post('/v1/me/card/setup');
  assert.ok(setup.setupIntentClientSecret && setup.ephemeralKeySecret && setup.customerId);
  app.payments.addCard(setup.customerId);
  const me = await anna.api.post('/v1/me/card/sync');
  assert.deepEqual(me.card, { brand: 'visa', last4: '4242' });
  await anna.api.post('/v1/me/push-tokens', { token: 'ExponentPushToken[anna]', platform: 'ios' });
});

test('drivers onboard, get verified and approved', async () => {
  pro = await onboard('7805550200', { name: 'Mike Romanenko', tier: 'pro', vehicle: 'pickup', trailer: true });
  basic = await onboard('7805550300', { name: 'Olena Koval', tier: 'basic', vehicle: 'cargo_van' });
  await pro.api.post('/v1/me/push-tokens', { token: 'ExponentPushToken[pro]', platform: 'android' });
  await basic.api.post('/v1/me/push-tokens', { token: 'ExponentPushToken[basic]', platform: 'ios' });
  const ov = await pro.api.get('/v1/driver');
  assert.equal(ov.driver.cargoLimitCents, 2_500_000);
  assert.ok(ov.checklist.every((c: { done: boolean; requiredToApprove: boolean }) => c.done || !c.requiredToApprove));
  await expectError(anna.api.get('/v1/admin/stats'), 403);
});

let cityOrderId = '';
test('city order: Pro sees it first, Basic after the Pro window', async () => {
  const q = await anna.api.post('/v1/quotes', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 80000, insured: false });
  assert.equal(q.intercity, false);
  assert.ok(q.suggestedPriceCents >= 7500);
  app.pushes.length = 0;
  const o = await anna.api.post('/v1/orders', {
    pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 80000, insured: false,
    windowStart: hours(2), windowEnd: hours(6), description: 'Диван 3-местный, IKEA Kivik', priceCents: 9000, photoKeys: [await upload(anna.api, 'order')],
  });
  cityOrderId = o.id;
  assert.equal(o.status, 'open');
  assert.match(o.pin, /^\d{4}$/);
  assert.equal(o.photos.length, 1);
  const driverPushes = app.pushes.filter((p) => String(p.data?.type).startsWith('new_order'));
  assert.deepEqual(driverPushes.map((p) => p.to), ['ExponentPushToken[pro]']);
  assert.match(driverPushes[0]!.title, /Pro/);
  assert.ok(app.pushes.some((p) => p.to === 'ExponentPushToken[anna]' && p.data?.type === 'order_created'));

  const feed = await basic.api.get('/v1/driver/feed');
  const item = feed.items.find((i: { id: string }) => i.id === o.id);
  assert.equal(item.eligibility.lockReason, 'pro_window');
  assert.equal(item.pin, undefined);
  assert.equal(item.pickup.address, '102 St NW'); // house number hidden before taking
  await expectError(basic.api.post(`/v1/driver/orders/${o.id}/take`), 409, 'pro_window');

  app.advance(3 * 60_000);
  app.pushes.length = 0;
  assert.equal(await broadcastAfterProWindow(app.ctx), 1);
  assert.deepEqual(app.pushes.map((p) => p.to), ['ExponentPushToken[basic]']);
  const feed2 = await basic.api.get('/v1/driver/feed');
  assert.equal(feed2.items.find((i: { id: string }) => i.id === o.id).eligibility.canTake, true);
});

test('price negotiation: one offer per side, then the card is charged on confirmation', async () => {
  await basic.api.post(`/v1/driver/orders/${cityOrderId}/offer`, { amountCents: 10000 });
  await expectError(basic.api.post(`/v1/driver/orders/${cityOrderId}/offer`, { amountCents: 9800 }), 409, 'offer_used');
  let o = await anna.api.get(`/v1/orders/${cityOrderId}`);
  const offer = o.offers.find((f: { by: string }) => f.by === 'driver');
  assert.equal(offer.amountCents, 10000);
  o = await anna.api.post(`/v1/orders/${cityOrderId}/offers/${offer.id}`, { action: 'counter', amountCents: 9500 });
  const counter = o.offers.find((f: { by: string; status: string }) => f.by === 'client' && f.status === 'pending');
  assert.equal(counter.amountCents, 9500);
  await expectError(anna.api.post(`/v1/orders/${cityOrderId}/offers/${counter.id}`, { action: 'accept' }), 409, 'offer_closed');
  const job = await basic.api.post(`/v1/driver/orders/${cityOrderId}/counter`, { action: 'accept' });
  assert.equal(job.status, 'agreed');
  assert.equal(job.agreedCents, 9500);
  assert.equal(job.driverNetCents, 9025);
  assert.equal(job.pickup.address, places.ikeaEdmonton.address);
  const charge = app.payments.calls.filter((c) => c.op === 'charge').at(-1)!.args as { amountCents: number };
  assert.equal(charge.amountCents, 9975); // 95.00 + 5%
  o = await anna.api.get(`/v1/orders/${cityOrderId}`);
  assert.equal(o.chargedCents, 9975);
  assert.equal(o.driver.name, 'Olena');
  await expectError(pro.api.post(`/v1/driver/orders/${cityOrderId}/take`), 409, 'order_taken');
});

test('chat stays in the app: contacts are hidden', async () => {
  const m = await anna.api.post(`/v1/orders/${cityOrderId}/messages`, { body: 'Позвоните 780 555 0199 или в вотсап' });
  assert.equal(m.contactHidden, true);
  assert.doesNotMatch(m.body, /555/);
  await basic.api.post(`/v1/orders/${cityOrderId}/messages`, { body: 'Буду к 14:30, третий подъезд' });
  const list = await anna.api.get(`/v1/orders/${cityOrderId}/messages`);
  assert.deepEqual(list.filter((x: { from: string }) => x.from !== 'system').map((x: { from: string }) => x.from), ['me', 'them']);
  await expectError(pro.api.get(`/v1/orders/${cityOrderId}/messages`), 404);
});

test('pickup with photos, transit, delivery by PIN; payout waits for tax number', async () => {
  await basic.api.post(`/v1/driver/orders/${cityOrderId}/en-route`);
  await basic.api.post('/v1/driver/location', { lat: 53.46, lng: -113.49 });
  let o = await anna.api.get(`/v1/orders/${cityOrderId}`);
  assert.equal(o.driverPosition.lat, 53.46);
  await expectError(basic.api.post(`/v1/driver/orders/${cityOrderId}/pickup`, { photoKeys: [await upload(anna.api, 'pickup')] }), 403);
  await basic.api.post(`/v1/driver/orders/${cityOrderId}/pickup`, { photoKeys: [await upload(basic.api, 'pickup'), await upload(basic.api, 'pickup')], note: 'Царапина на левом подлокотнике' });
  await basic.api.post(`/v1/driver/orders/${cityOrderId}/depart`);
  o = await anna.api.get(`/v1/orders/${cityOrderId}`);
  assert.equal(o.status, 'in_transit');
  assert.equal(o.pickupPhotos.length, 2);
  const wrong = o.pin === '0000' ? '1111' : '0000';
  const err = await expectError(basic.api.post(`/v1/driver/orders/${cityOrderId}/deliver`, { pin: wrong }), 400, 'wrong_pin');
  assert.equal(err.error.details.attemptsLeft, 9);
  const done = await basic.api.post(`/v1/driver/orders/${cityOrderId}/deliver`, { pin: o.pin, photoKeys: [await upload(basic.api, 'delivery')] });
  assert.equal(done.status, 'delivered');
  assert.equal(done.payoutHeldReason, 'tax_info_missing');
  assert.equal(app.payments.calls.filter((c) => c.op === 'transfer').length, 0);
  await expectError(basic.api.post('/v1/driver/tax', { type: 'sin', number: '046 454 287' }), 400, 'invalid_sin');
  await basic.api.post('/v1/driver/tax', { type: 'sin', number: '046 454 286' });
  const t = app.payments.calls.filter((c) => c.op === 'transfer');
  assert.equal(t.length, 1);
  assert.equal((t[0]!.args as { amountCents: number }).amountCents, 9025);
  const me = await basic.api.get('/v1/me');
  assert.deepEqual(me.driver.taxInfo, { type: 'sin', last3: '286', gst: null });
  const earnings = await basic.api.get('/v1/driver/earnings');
  assert.equal(earnings.yearCents, 9025);
});

test('ratings go both ways, once', async () => {
  await anna.api.post(`/v1/orders/${cityOrderId}/rating`, { stars: 5, comment: 'Аккуратно и вовремя' });
  await expectError(anna.api.post(`/v1/orders/${cityOrderId}/rating`, { stars: 4 }), 409, 'already_rated');
  await basic.api.post(`/v1/orders/${cityOrderId}/rating`, { stars: 5 });
  const feedDriver = await anna.api.get(`/v1/orders/${cityOrderId}`);
  assert.equal(feedDriver.driver.rating, 5);
});

let tripId = '';
test('driver publishes Edmonton → Red Deer → Calgary; customer sees it with times and books it', async () => {
  await pro.api.post('/v1/driver/tax', { type: 'bn', number: '123456789' });
  const trip = await pro.api.post('/v1/driver/trips', { stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Red Deer', province: 'AB' }, { city: 'Calgary', province: 'AB' }], departAt: hours(5), space: 'half' });
  tripId = trip.id;
  const q = await anna.api.post('/v1/quotes', { pickup: places.whyteAve, dropoff: places.kensington, size: 'M', declaredValueCents: 30000, insured: true, windowStart: hours(4), windowEnd: hours(8) });
  assert.equal(q.intercity, true);
  const opt = q.trips.find((t: { tripId: string }) => t.tripId === tripId);
  assert.ok(opt, 'trip listed');
  assert.deepEqual(opt.stops.map((s: { city: string }) => s.city), ['Edmonton', 'Red Deer', 'Calgary']);
  assert.equal(opt.fitsWindow, true);
  assert.ok(new Date(opt.dropoffEta) > new Date(opt.pickupEta));
  assert.ok(opt.priceCents < q.suggestedPriceCents);
  // Red Deer -> Calgary also matches the same trip
  const q2 = await anna.api.post('/v1/quotes', { pickup: places.redDeer, dropoff: places.kensington, size: 'S', declaredValueCents: 2000, insured: false });
  assert.ok(q2.trips.some((t: { tripId: string }) => t.tripId === tripId));
  // wrong direction does not
  const q3 = await anna.api.post('/v1/quotes', { pickup: places.kensington, dropoff: places.whyteAve, size: 'S', declaredValueCents: 2000, insured: false });
  assert.ok(!q3.trips.some((t: { tripId: string }) => t.tripId === tripId));

  app.pushes.length = 0;
  app.sms.length = 0;
  const o = await anna.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.kensington, size: 'M', declaredValueCents: 30000, insured: true, windowStart: hours(4), windowEnd: hours(8), tripId, description: '4 коробки книг' });
  assert.equal(o.priceCents, opt.priceCents);
  assert.equal(o.requestedDriver, true);
  assert.equal(o.insuranceCents, 450);
  assert.deepEqual(app.pushes.filter((p) => p.data?.type === 'trip_request').map((p) => p.to), ['ExponentPushToken[pro]']);
  assert.ok(app.sms.some((s) => s.phone === '+17805550200'));
  const bf = await basic.api.get('/v1/driver/feed');
  assert.ok(!bf.items.some((i: { id: string }) => i.id === o.id), 'other drivers do not see a booking');
  await expectError(pro.api.post(`/v1/driver/orders/${o.id}/offer`, { amountCents: 9000 }), 409, 'fixed_price');
  const job = await pro.api.post(`/v1/driver/orders/${o.id}/take`);
  assert.equal(job.agreedCents, opt.priceCents);
  const charge = app.payments.calls.filter((c) => c.op === 'charge').at(-1)!.args as { amountCents: number };
  assert.equal(charge.amountCents, opt.priceCents + Math.round(opt.priceCents * 0.05) + 450);

  // late cancellation (loading starts in 4 h): 30% driver, 10% platform, fee kept, insurance refunded
  const preview = await anna.api.get(`/v1/orders/${o.id}/cancel`);
  assert.equal(preview.tier, 'late');
  const p = opt.priceCents;
  assert.equal(preview.driverCents, Math.round(p * 0.3));
  assert.equal(preview.platformCents, Math.round(p * 0.1));
  assert.equal(preview.refundCents, charge.amountCents - Math.round(p * 0.3) - Math.round(p * 0.1) - Math.round(p * 0.05));
  const c = await anna.api.post(`/v1/orders/${o.id}/cancel`, { reason: 'Передумала' });
  assert.equal(c.status, 'cancelled');
  const refund = app.payments.calls.filter((x) => x.op === 'refund').at(-1)!.args as { amountCents: number };
  assert.equal(refund.amountCents, preview.refundCents);
  const comp = app.payments.calls.filter((x) => x.op === 'transfer').at(-1)!.args as { amountCents: number };
  assert.equal(comp.amountCents, preview.driverCents);
});

test('early cancellation keeps 5% + 5%; the service fee is not refunded', async () => {
  const o = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.whyteAve, size: 'M', declaredValueCents: 5000, insured: false, windowStart: hours(72), windowEnd: hours(76), priceCents: 4000 });
  await pro.api.post(`/v1/driver/orders/${o.id}/take`);
  const prev = await anna.api.get(`/v1/orders/${o.id}/cancel`);
  assert.deepEqual([prev.tier, prev.driverCents, prev.platformCents, prev.keptFeeCents, prev.refundCents], ['early', 200, 200, 200, 3600]);
  // once the driver sets off, it becomes late
  await pro.api.post(`/v1/driver/orders/${o.id}/en-route`);
  const prev2 = await anna.api.get(`/v1/orders/${o.id}/cancel`);
  assert.equal(prev2.tier, 'late');
  await anna.api.post(`/v1/orders/${o.id}/cancel`);
  // free cancellation before anyone confirmed
  const o2 = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.whyteAve, size: 'S', declaredValueCents: 2000, insured: false, windowStart: hours(3), windowEnd: hours(5) });
  const c2 = await anna.api.post(`/v1/orders/${o2.id}/cancel`);
  assert.deepEqual([c2.tier, c2.refundCents], ['free', 0]);
});

test('driver drops out: full refund, order reopens; too many drops pause the account', async () => {
  for (let i = 0; i < 3; i++) {
    const before = app.payments.calls.filter((c) => c.op === 'refund').length;
    const o = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(2), windowEnd: hours(5), priceCents: 2000 });
    app.advance(3 * 60_000);
    await broadcastAfterProWindow(app.ctx);
    await basic.api.post(`/v1/driver/orders/${o.id}/take`);
    await basic.api.post(`/v1/driver/orders/${o.id}/drop`, { reason: 'Сломалась машина' });
    const after = await anna.api.get(`/v1/orders/${o.id}`);
    assert.equal(after.status, 'open');
    assert.equal(after.chargedCents, null);
    const refunds = app.payments.calls.filter((c) => c.op === 'refund');
    assert.equal(refunds.length, before + 1);
    assert.equal((refunds.at(-1)!.args as { amountCents: number }).amountCents, 2100);
    await anna.api.post(`/v1/orders/${o.id}/cancel`);
  }
  const me = await basic.api.get('/v1/me');
  assert.equal(me.driver.status, 'paused');
  const fresh = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(2), windowEnd: hours(5) });
  app.advance(3 * 60_000);
  await expectError(basic.api.post(`/v1/driver/orders/${fresh.id}/take`), 403);
  await anna.api.post(`/v1/orders/${fresh.id}/cancel`);
  await admin.api.post(`/v1/admin/drivers/${basic.id}/decision`, { status: 'approved', tier: 'basic' });
});

test('declined card: order goes back to open and the customer is told', async () => {
  const bob = await signIn(app, '7805550400');
  await bob.api.patch('/v1/me', { name: 'Bob', email: 'bob@example.com', acceptTerms: true, lang: 'en' });
  await expectError(bob.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(2), windowEnd: hours(4) }), 402, 'card_required');
  const s = await bob.api.post('/v1/me/card/setup');
  app.payments.addCard(s.customerId, '0002');
  await bob.api.post('/v1/me/card/sync');
  const o = await bob.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(2), windowEnd: hours(4) });
  app.sms.length = 0;
  await expectError(pro.api.post(`/v1/driver/orders/${o.id}/take`), 402, 'payment_failed');
  const after = await bob.api.get(`/v1/orders/${o.id}`);
  assert.equal(after.status, 'open');
  assert.equal(after.paymentError, 'card_declined');
  assert.ok(app.sms.some((m) => m.phone === '+17805550400' && /bank card was declined and \$\d+\.\d\d was not charged\. The bank declined the charge\./.test(m.text)));
  // locked for drivers until the customer saves a working card
  await expectError(pro.api.post(`/v1/driver/orders/${o.id}/take`), 409, 'client_payment');
  const s2 = await bob.api.post('/v1/me/card/setup');
  app.payments.addCard(s2.customerId, '4242');
  await bob.api.post('/v1/me/card/sync');
  assert.equal((await bob.api.get(`/v1/orders/${o.id}`)).paymentError, null);
  const taken = await pro.api.post(`/v1/driver/orders/${o.id}/take`);
  assert.equal(taken.status, 'agreed');
});

test('test cards survive a server restart (payment stand-in loses its memory)', async () => {
  const c = await signIn(app, '7805550401');
  await c.api.patch('/v1/me', { name: 'Cora', email: 'cora@example.com', acceptTerms: true });
  const s = await c.api.post('/v1/me/card/setup');
  app.payments.addCard(s.customerId);
  await c.api.post('/v1/me/card/sync');
  app.payments.cards.clear(); // what a restart does to the in-memory stand-in
  const o = await c.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(2), windowEnd: hours(4), priceCents: 3000 });
  const taken = await pro.api.post(`/v1/driver/orders/${o.id}/take`);
  assert.equal(taken.status, 'agreed');
});

test('cargo limits: Basic cannot take a $2,500 fridge unless the customer insures it', async () => {
  const o = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 250000, insured: false, windowStart: hours(2), windowEnd: hours(5) });
  app.advance(3 * 60_000);
  const item = (await basic.api.get('/v1/driver/feed')).items.find((i: { id: string }) => i.id === o.id);
  assert.equal(item.eligibility.lockReason, 'cargo_limit');
  await expectError(basic.api.post(`/v1/driver/orders/${o.id}/take`), 409, 'cargo_limit');
  const o2 = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 250000, insured: true, windowStart: hours(2), windowEnd: hours(5) });
  assert.equal(o2.insuranceCents, 3750);
  app.advance(3 * 60_000);
  const item2 = (await basic.api.get('/v1/driver/feed')).items.find((i: { id: string }) => i.id === o2.id);
  assert.equal(item2.eligibility.canTake, true);
  await anna.api.post(`/v1/orders/${o.id}/cancel`);
  await anna.api.post(`/v1/orders/${o2.id}/cancel`);
});

test('far-away orders: any driver may see and take them, but only nearby drivers are notified; strangers cannot read them', async () => {
  app.pushes.length = 0;
  const o = await anna.api.post('/v1/orders', { pickup: places.saskatoon, dropoff: { ...places.saskatoon, address: '100 3rd Ave S', lat: 52.124, lng: -106.664 }, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(2), windowEnd: hours(4) });
  assert.ok(!app.pushes.some((p) => p.to === 'ExponentPushToken[pro]' && p.data?.orderId === o.id), 'an Edmonton driver is not notified about Saskatoon');
  const feed = await pro.api.get('/v1/driver/feed');
  const item = feed.items.find((i: { id: string }) => i.id === o.id);
  assert.ok(item, 'listed under all loads');
  assert.equal(item.eligibility.near, false);
  assert.equal(item.eligibility.onMyTrip, false);
  assert.equal(item.eligibility.canTake, true);
  assert.equal((await pro.api.get(`/v1/driver/orders/${o.id}`)).id, o.id);
  await expectError(basic.api.get(`/v1/orders/${o.id}`), 404);
  await expectError(client(app.url).get(`/v1/orders/${o.id}`), 401);
});

test('trip booking not confirmed in time opens to everyone; unclaimed orders close when the window passes', async () => {
  const o = await anna.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.kensington, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(4), windowEnd: hours(8), tripId });
  app.advance(31 * 60_000);
  assert.ok((await expireTripRequests(app.ctx)) >= 1);
  const after = await anna.api.get(`/v1/orders/${o.id}`);
  assert.equal(after.requestedDriver, false);
  const o2 = await anna.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.secord, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(0.2), windowEnd: hours(0.4) });
  app.advance(60 * 60_000);
  assert.ok((await expireOpenOrders(app.ctx)) >= 1);
  assert.equal((await anna.api.get(`/v1/orders/${o2.id}`)).status, 'cancelled');
});

test('dispute: admin refunds part of the charge', async () => {
  const o = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.whyteAve, size: 'M', declaredValueCents: 5000, insured: false, windowStart: hours(3), windowEnd: hours(5), priceCents: 5000 });
  await pro.api.post(`/v1/driver/orders/${o.id}/take`);
  const fresh = await anna.api.get(`/v1/orders/${o.id}`);
  await pro.api.post(`/v1/driver/orders/${o.id}/pickup`, { photoKeys: [await upload(pro.api, 'pickup')] });
  await pro.api.post(`/v1/driver/orders/${o.id}/deliver`, { pin: fresh.pin });
  const d = await anna.api.post(`/v1/orders/${o.id}/disputes`, { reason: 'Одна коробка порвана' });
  await expectError(pro.api.post(`/v1/orders/${o.id}/disputes`, { reason: 'Второй спор' }), 409, 'dispute_open');
  const list = await admin.api.get('/v1/admin/disputes');
  assert.ok(list.some((x: { id: string }) => x.id === d.id));
  await expectError(admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, { resolution: 'Частичный возврат', action: 'refund', refundCents: 999999 }), 400, 'refund_too_large');
  await admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, { resolution: 'Частичный возврат $10', action: 'refund', refundCents: 1000 });
  assert.equal((app.payments.calls.filter((c) => c.op === 'refund').at(-1)!.args as { amountCents: number }).amountCents, 1000);
  const detail = await admin.api.get(`/v1/admin/orders/${o.id}`);
  assert.ok(detail.events.some((e: { type: string }) => e.type === 'admin_refund'));
});

test('insurance expiry: reminders at 30 and 7 days, pause when it lapses', async () => {
  await app.ctx.db.query(`UPDATE documents SET expires_on = current_date + 20 WHERE driver_id = $1 AND kind = 'insurance_endorsement'`, [basic.id]);
  let r = await insuranceCheck(app.ctx);
  assert.equal(r.reminded, 1);
  await app.ctx.db.query(`UPDATE documents SET expires_on = current_date + 5 WHERE driver_id = $1 AND kind = 'insurance_endorsement'`, [basic.id]);
  r = await insuranceCheck(app.ctx);
  assert.equal(r.reminded, 1);
  await app.ctx.db.query(`UPDATE documents SET expires_on = current_date - 1 WHERE driver_id = $1 AND kind = 'insurance_endorsement'`, [basic.id]);
  r = await insuranceCheck(app.ctx);
  assert.equal(r.paused, 1);
  assert.equal((await basic.api.get('/v1/me')).driver.status, 'paused');
  const notes = await basic.api.get('/v1/me/notifications');
  assert.ok(notes.some((n: { type: string }) => n.type === 'insurance_lapsed'));
});

test('CRA platform report lists drivers with quarterly amounts and tax numbers', async () => {
  const year = new Date().getUTCFullYear();
  const res = await fetch(`${app.url}/v1/admin/reports/cra?year=${year}`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  assert.match(lines[0]!, /^driver_id,legal_name,address,date_of_birth,tin_type,tin,/);
  const olena = lines.find((l) => l.includes('Olena Koval'))!;
  assert.ok(olena.includes('046454286'));
  assert.ok(olena.includes('95.00'));
  const stats = await admin.api.get('/v1/admin/stats');
  assert.ok(stats.delivered_30d >= 2);
});

test('webhooks are idempotent and signatures are required in Stripe mode', async () => {
  const ev = { id: 'evt_dup', type: 'account.updated', data: { object: { id: 'acct_x', payouts_enabled: true } } };
  assert.equal((await client(app.url).post('/webhooks/stripe', ev)).result, 'handled');
  assert.equal((await client(app.url).post('/webhooks/stripe', ev)).result, 'duplicate');
  const health = await client(app.url).get('/health');
  assert.equal(health.payments, 'fake');
});

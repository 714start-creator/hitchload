// Website features: route matching both ways, route alerts, trip requests,
// public search, email confirmation, browser push.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { after, before, test } from 'node:test';
import { encryptPayload, generateVapidKeys, vapidAuth } from '../src/providers/webpush.js';
import { broadcastAfterProWindow } from '../src/services/workers.js';
import { client, confirmEmail, customer, expectError, JPEG, onboardDriver, places, signIn, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;
let mike: Awaited<ReturnType<typeof onboardDriver>>; // Pro driver
let olya: Awaited<ReturnType<typeof customer>>; // has a route alert Edmonton → Calgary
let anna: Awaited<ReturnType<typeof customer>>; // has an open order Edmonton → Calgary
let annaOrderId = '';
let tripId = '';
let alertId = '';
const hours = (h: number) => new Date(app.ctx.now().getTime() + h * 3_600_000).toISOString();
const notes = (userId: string, type: string) => app.hubEvents.filter((e) => e.userId === userId && e.type === 'notification' && (e.data as { type: string }).type === type).map((e) => e.data as { title: string; body: string; link: string; orderId: string | null });

before(async () => {
  app = await startTestApp('web');
});
after(async () => {
  await app?.close();
});

test('email is confirmed by a link; confirmations go only to confirmed addresses', async () => {
  olya = await customer(app, '7805550411', 'Olya Shevchenko');
  const email = 'olya0411@example.com';
  const mail = app.emails.find((m) => m.to === email);
  assert.ok(mail, 'confirmation email sent');
  assert.match(mail.html, /Confirm email/);
  assert.equal((await olya.api.get('/v1/me')).emailVerified, false);
  // a forged token does not work
  const forged = await fetch(`${app.url}/v1/auth/email/verify?u=${olya.user.id}&t=nope`, { redirect: 'manual' });
  assert.match(forged.headers.get('location')!, /email=expired/);
  const res = await confirmEmail(app, email);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /\/account\?email=verified$/);
  assert.equal((await olya.api.get('/v1/me')).emailVerified, true);
  // changing the address needs a new confirmation
  await olya.api.patch('/v1/me', { email: 'olya.new@example.com' });
  assert.equal((await olya.api.get('/v1/me')).emailVerified, false);
  await confirmEmail(app, 'olya.new@example.com');
  assert.equal((await olya.api.get('/v1/me')).emailVerified, true);
});

test('a shipper saves a route alert and sees current trips right away', async () => {
  mike = await onboardDriver(app, '7805550200', { name: 'Mike Shevchuk', tier: 'pro' });
  await expectError(olya.api.post('/v1/alerts', { from: { city: 'Edmonton', province: 'AB' }, to: { city: 'Edmonton', province: 'AB' } }), 400, 'same_city');
  await expectError(olya.api.post('/v1/alerts', { from: { city: 'Atlantis', province: 'AB' }, to: { city: 'Calgary', province: 'AB' } }), 400, 'unknown_city');
  const r = await olya.api.post('/v1/alerts', { from: { city: 'Edmonton', province: 'AB' }, to: { city: 'Calgary', province: 'AB' } });
  alertId = r.alert.id;
  assert.equal(r.alert.from.city, 'Edmonton');
  assert.deepEqual(r.trips, []);
  // the same alert again is not duplicated
  const again = await olya.api.post('/v1/alerts', { from: { city: 'Edmonton', province: 'AB' }, to: { city: 'Calgary', province: 'AB' } });
  assert.equal(again.alert.id, alertId);
  assert.equal((await olya.api.get('/v1/alerts')).length, 1);
});

test('driver publishes a trip: finds loads on the route, shippers on that route are told', async () => {
  anna = await customer(app, '7805550123', 'Anna Kovalenko');
  await confirmEmail(app, 'anna0123@example.com');
  const o = await anna.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.kensington, size: 'M', declaredValueCents: 20000, insured: false, windowStart: hours(1), windowEnd: hours(10), description: 'Велосипед', priceCents: 9000 });
  annaOrderId = o.id;
  assert.ok(app.emails.some((m) => m.to === 'anna0123@example.com' && m.subject.includes(`#${o.number}`)), 'order confirmation email');
  // a load going the other way must not match
  const boris = await customer(app, '7805550500', 'Boris Petrenko');
  await boris.api.post('/v1/orders', { pickup: places.kensington, dropoff: places.whyteAve, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(1), windowEnd: hours(10), priceCents: 6000 });

  app.hubEvents.length = 0;
  app.emails.length = 0;
  const t = await mike.api.post('/v1/driver/trips', { stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Red Deer', province: 'AB' }, { city: 'Calgary', province: 'AB' }], departAt: hours(2), space: 'half' });
  tripId = t.id;
  assert.equal(t.matches.loads, 1);
  assert.equal(t.matches.shippersNotified, 2);

  const loads = await mike.api.get(`/v1/driver/trips/${tripId}/loads`);
  assert.deepEqual(loads.items.map((i: { id: string }) => i.id), [annaOrderId]);
  assert.equal(loads.items[0].fitsWindow, true);
  assert.equal(loads.items[0].pickup.address.includes('10405'), false, 'house number hidden');

  const [toAnna] = notes(anna.user.id, 'driver_on_your_order');
  assert.ok(toAnna);
  assert.match(toAnna.body, /Mike is driving Edmonton → Red Deer → Calgary/);
  assert.equal(toAnna.link, `/o/${annaOrderId}?trip=${tripId}`);
  const [toOlya] = notes(olya.user.id, 'driver_on_alert');
  assert.ok(toOlya);
  assert.match(toOlya.link, /^\/send\?from=Edmonton%2C\+AB&to=Calgary%2C\+AB&trip=/);
  const mail = app.emails.find((m) => m.to === 'olya.new@example.com');
  assert.ok(mail, 'alert email to the confirmed address');
  assert.match(mail.html, /Stop alerts for this route/);
  assert.equal(notes(boris.user.id, 'driver_on_your_order').length, 0, 'opposite direction is not matched');

  // the public search shows the trip
  const s = await client(app.url).get('/v1/public/trips?from=Edmonton,%20AB&to=Calgary,%20AB');
  assert.equal(s.trips.length, 1);
  assert.equal(s.trips[0].driver.name, 'Mike');
  const red = await client(app.url).get('/v1/public/trips?from=Red%20Deer,%20AB&to=Calgary,%20AB');
  assert.equal(red.trips.length, 1, 'joins at an intermediate stop');
  const back = await client(app.url).get('/v1/public/trips?from=Calgary,%20AB&to=Edmonton,%20AB');
  assert.equal(back.trips.length, 0);
  await expectError(client(app.url).get('/v1/public/trips?from=Edmonton&to=Calgary,%20AB'), 400, 'invalid_city');
});

test('the shipper asks that driver to take the open order; the driver confirms', async () => {
  app.hubEvents.length = 0;
  const r = await anna.api.post(`/v1/orders/${annaOrderId}/request-trip`, { tripId });
  assert.ok(r.requestExpiresAt);
  await expectError(anna.api.post(`/v1/orders/${annaOrderId}/request-trip`, { tripId }), 409, 'request_pending');
  assert.equal(notes(mike.id, 'trip_request').length, 1);
  const taken = await mike.api.post(`/v1/driver/orders/${annaOrderId}/take`);
  assert.equal(taken.status, 'agreed');
  assert.ok(app.payments.calls.some((c) => c.op === 'charge'));
});

test('a new load posted along a published trip goes to that driver once, naming the trip', async () => {
  app.hubEvents.length = 0;
  const boris = await signIn(app, '7805550500');
  const o = await boris.api.post('/v1/orders', { pickup: places.redDeer, dropoff: places.kensington, size: 'S', declaredValueCents: 1000, insured: false, windowStart: hours(2), windowEnd: hours(9), priceCents: 7000 });
  const got = notes(mike.id, 'new_order_on_trip');
  assert.equal(got.length, 1);
  assert.match(got[0]!.body, /Red Deer → Calgary · \$70\.00\. Fits your trip Edmonton → Calgary/);
  assert.equal(got[0]!.orderId, o.id);
  // when the Pro window ends the same driver is not told again
  app.advance(31 * 60_000);
  await broadcastAfterProWindow(app.ctx);
  assert.equal(notes(mike.id, 'new_order_on_trip').length, 1);
});

test('one-click unsubscribe from the email stops that alert', async () => {
  const bad = await fetch(`${app.url}/v1/alerts/${alertId}/unsubscribe?s=forged`, { redirect: 'manual' });
  assert.match(bad.headers.get('location')!, /alert=invalid/);
  const mail = app.emails.find((m) => m.to === 'olya.new@example.com')!;
  const link = /href="([^"]+\/unsubscribe\?s=[^"]+)"/.exec(mail.html)![1]!.replace(app.ctx.cfg.publicUrl, '');
  const res = await fetch(app.url + link, { redirect: 'manual' });
  assert.match(res.headers.get('location')!, /alert=off/);
  assert.equal((await olya.api.get('/v1/alerts')).length, 0);
  app.hubEvents.length = 0;
  await mike.api.post('/v1/driver/trips', { stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Calgary', province: 'AB' }], departAt: hours(30) });
  assert.equal(notes(olya.user.id, 'driver_on_alert').length, 0);
});

test('public load board shows cities, size, window and price, never addresses or names', async () => {
  const loads = await client(app.url).get('/v1/public/loads');
  assert.ok(loads.length >= 1);
  for (const l of loads) {
    assert.deepEqual(Object.keys(l.from).sort(), ['city', 'province']);
    assert.equal(JSON.stringify(l).includes('Ross St'), false);
    assert.equal('description' in l, false);
  }
  const calgary = await client(app.url).get('/v1/public/loads?to=calg');
  assert.ok(calgary.every((l: { to: { city: string } }) => l.to.city === 'Calgary'));
  const stats = await client(app.url).get('/v1/public/stats');
  assert.equal(stats.drivers, 1);
  assert.ok(stats.trips >= 2);
  const site = await client(app.url).get('/v1/public/site');
  assert.equal(site.brand, 'Hitchload');
});

test('a trip around one city (Edmonton → Edmonton) is allowed and finds local loads', async () => {
  const local = await customer(app, '7805550901', 'Ira Local');
  const o = await local.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'M', declaredValueCents: 1000, insured: false, windowStart: hours(1), windowEnd: hours(10), priceCents: 4000 });
  const t = await mike.api.post('/v1/driver/trips', { stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Edmonton', province: 'AB' }], departAt: hours(2) });
  const loads = await mike.api.get(`/v1/driver/trips/${t.id}/loads`);
  assert.ok(loads.items.some((i: { id: string }) => i.id === o.id));
});

test('a personal auto policy is accepted for Basic only with the driver\'s risk confirmation; Accept all & approve', async () => {
  const s = await signIn(app, '7805550931');
  await s.api.patch('/v1/me', { name: 'Petro Personal', email: 'petro@example.com', acceptTerms: true });
  await s.api.post('/v1/driver');
  const up = await s.api.post('/v1/uploads?purpose=document', JPEG, { 'Content-Type': 'image/jpeg' });
  await expectError(s.api.post('/v1/driver/documents', { kind: 'insurance_auto', fileKey: up.key, insurer: 'TD', policyNumber: 'X1', expiresOn: '2027-01-01' }), 400, 'risk_ack_required');
  const p = await onboardDriver(app, '7805550932', { name: 'Pavlo Personal', tier: 'basic', personalPolicy: true, approve: false });
  const admin = await signIn(app, '+17800000001');
  const before = await admin.api.get(`/v1/admin/drivers/${p.id}`);
  const ck = (o: { checklist: { key: string; done: boolean }[] }, k: string) => o.checklist.find((c) => c.key === k)!.done;
  assert.equal(ck(before, 'delivery_insurance'), true, 'personal policy with confirmation counts');
  assert.equal(ck(before, 'vehicle_photos'), true);
  assert.equal(ck(before, 'background_clear'), false);
  assert.ok(before.documents.find((d: { kind: string }) => d.kind === 'insurance_auto').riskAcknowledgedAt);
  // whatever the admin types, a personal policy alone caps the item value at $1,000
  const done = await admin.api.post(`/v1/admin/drivers/${p.id}/approve-all`, { tier: 'basic', cargoLimitCents: 500000 });
  assert.equal(done.driver.status, 'approved');
  assert.equal(done.driver.cargoLimitCents, 100000);
  assert.equal(ck(done, 'background_clear'), true, 'accepting the record-check document marks it clear');
});

test('vehicle photos are required to send the application', async () => {
  const s = await signIn(app, '7805550933');
  await s.api.patch('/v1/me', { name: 'Nadia Nophoto', email: 'nadia@example.com', acceptTerms: true });
  const ov = await s.api.post('/v1/driver');
  assert.equal(ov.checklist.find((c: { key: string }) => c.key === 'vehicle_photos').done, false);
  const body = await expectError(s.api.post('/v1/driver/submit'), 400);
  assert.ok(body.error.details.missing.includes('vehicle_photos'));
});

test('a new order notifies every driver based in the pickup city, even outside their radius', async () => {
  // home in north Edmonton with a 5 km radius; the pickup is ~20 km away in south Edmonton
  const north = await onboardDriver(app, '7805550934', { name: 'Oleh North', tier: 'pro', home: { lat: 53.63, lng: -113.49 }, radiusKm: 5 });
  app.hubEvents.length = 0;
  const c = await signIn(app, '7805550123');
  await c.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(1), windowEnd: hours(6), priceCents: 2500 });
  assert.ok(app.hubEvents.some((e) => e.userId === north.id && e.type === 'notification'), 'driver in the same city is notified');
  // a Calgary-based driver is not
  const south = await onboardDriver(app, '7805550935', { name: 'Ivan Calgary', tier: 'pro', homeCity: 'Calgary', home: { lat: 51.05, lng: -114.07 }, radiusKm: 30 });
  app.hubEvents.length = 0;
  await c.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(1), windowEnd: hours(6), priceCents: 2600 });
  assert.equal(app.hubEvents.some((e) => e.userId === south.id && e.type === 'notification'), false);
});

test('browser push: subscribe, receive, unsubscribe', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  await expectError(anna.api.post('/v1/me/push-tokens', { token: JSON.stringify({ ...sub, endpoint: 'http://insecure.example' }), platform: 'web' }), 400, 'invalid_push_token');
  await anna.api.post('/v1/me/push-tokens', { token: JSON.stringify(sub), platform: 'web' });
  app.webPushes.length = 0;
  const { notify } = await import('../src/services/notify.js');
  await notify(app.ctx, anna.user.id, 'delivered', { number: 5 }, { orderId: annaOrderId });
  assert.equal(app.webPushes.length, 1);
  assert.deepEqual(app.webPushes[0]!.payload, { title: 'Delivered', body: 'Order #5 delivered. Rate your driver', url: `/o/${annaOrderId}`, tag: annaOrderId });
  await anna.api.del('/v1/me/push-tokens', { token: JSON.stringify(sub) });
  app.webPushes.length = 0;
  await notify(app.ctx, anna.user.id, 'delivered', { number: 5 });
  assert.equal(app.webPushes.length, 0);
});

test('web push encryption (RFC 8291) decrypts on the receiving side; VAPID signature verifies', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: 'Привет', body: 'x'.repeat(500) }));
  const blob = encryptPayload(msg, ua.getPublicKey(), auth);
  // receiver, written from the RFC independently of the sender code
  const salt = blob.subarray(0, 16);
  assert.equal(blob.readUInt32BE(16), 4096);
  const idlen = blob[20]!;
  const asPublic = blob.subarray(21, 21 + idlen);
  const ct = blob.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record padding delimiter');
  assert.deepEqual(plain.subarray(0, -1), msg);

  const keys = generateVapidKeys();
  const header = vapidAuth('https://fcm.googleapis.com', 'mailto:ops@example.com', keys.publicKey, keys.privateKey, 1_800_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43_200, sub: 'mailto:ops@example.com' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url')));
});

test('database file storage (test servers without S3): put, signed read, bad signature', async () => {
  const { createDbStorage } = await import('../src/providers/storage.js');
  const st = createDbStorage(app.ctx.db, 'https://example.test', 'secret');
  const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  await st.put('u/x/document/a.jpg', body, 'image/jpeg');
  const u = new URL(st.url('u/x/document/a.jpg'));
  const back = await st.readLocal!('u/x/document/a.jpg', u.searchParams.get('exp')!, u.searchParams.get('sig')!);
  assert.deepEqual(back, body);
  assert.equal(await st.readLocal!('u/x/document/a.jpg', u.searchParams.get('exp')!, 'forged'), null);
  assert.equal(await st.readLocal!('u/x/document/missing.jpg', u.searchParams.get('exp')!, u.searchParams.get('sig')!), null);
});

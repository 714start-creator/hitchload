// The app's API client against the real server (and pure helpers).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApi, ApiError } from '../src/api';
import { buildWindow, countdown, dollarsToCents, maskPhone, money, placeFromGoogle } from '../src/format';
import { dictionaries, translate } from '../src/i18n';
import { ADMIN_PHONE, JPEG, places, signIn, startTestApp, type TestApp } from '../../server/test/helpers';

test('helpers', () => {
  assert.equal(money(9975), '$99.75');
  assert.equal(dollarsToCents('99,5'), 9950);
  assert.equal(dollarsToCents('$1 200'), 120000);
  assert.equal(maskPhone('17805550123'), '(780) 555-0123');
  assert.equal(countdown(new Date(Date.now() + 150_000).toISOString())?.startsWith('2:'), true);
  assert.equal(countdown(new Date(Date.now() - 1).toISOString()), null);
  const base = new Date(2026, 9, 28, 9, 0);
  const w = buildWindow(1, '10:00', '18:30', base)!;
  assert.equal(new Date(w.start).getDate(), 29);
  assert.equal(new Date(w.end).getHours(), 18);
  assert.equal(buildWindow(0, '18:00', '10:00', base), null);
  assert.equal(buildWindow(0, '25:00', '26:00', base), null);
});

test('every language has every string, with the same placeholders', () => {
  const ru = dictionaries.ru;
  for (const [k, v] of Object.entries(ru)) {
    const en = dictionaries.en[k as keyof typeof ru];
    assert.ok(en, `en missing ${k}`);
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(ph(en), ph(v), `placeholders differ in ${k}`);
  }
  assert.equal(translate('ru', 'take', { price: '$90.00' }), 'Взять за $90.00');
});

test('Google place → server place', () => {
  const p = placeFromGoogle({
    formattedAddress: '1025 Secord Promenade NW, Edmonton, AB T6M 0Z7, Canada',
    location: { latitude: 53.4878, longitude: -113.6889 },
    addressComponents: [
      { longText: 'Edmonton', shortText: 'Edmonton', types: ['locality', 'political'] },
      { longText: 'Alberta', shortText: 'AB', types: ['administrative_area_level_1', 'political'] },
      { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
    ],
  });
  assert.deepEqual(p, { address: '1025 Secord Promenade NW', city: 'Edmonton', province: 'AB', lat: 53.4878, lng: -113.6889 });
  assert.equal(placeFromGoogle({ formattedAddress: 'Seattle, WA, USA', location: { latitude: 47.6, longitude: -122.3 }, addressComponents: [{ longText: 'Seattle', types: ['locality'] }, { shortText: 'WA', types: ['administrative_area_level_1'] }, { shortText: 'US', types: ['country'] }] }), null);
});

let app: TestApp;
before(async () => {
  app = await startTestApp('mobile');
});
after(async () => {
  await app?.close();
});

test('the app client drives a full order against the real server', async () => {
  let token: string | null = null;
  const api = createApi(app.url, () => token);
  // sign in exactly as the app does
  const start = await api.startOtp('(780) 555-0123');
  assert.ok(start.devCode);
  await assert.rejects(api.verifyOtp(start.phone, '000000'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_code');
  const v = await api.verifyOtp(start.phone, start.devCode!);
  token = v.token;
  await api.updateMe({ name: 'Anna', email: 'anna@example.com', acceptTerms: true });
  const setup = await api.cardSetup();
  app.payments.addCard(setup.customerId);
  const me = await api.cardSync();
  assert.equal(me.card?.last4, '4242');
  const cfg = await api.config();
  assert.equal(cfg.rules.cancelLateHours, 24);
  assert.ok((await api.cities()).some((c) => c.city === 'Red Deer'));

  // a driver, prepared through the server helpers
  const admin = await signIn(app, ADMIN_PHONE);
  const drv = await signIn(app, '7805550200');
  let dToken: string | null = drv.token;
  const dapi = createApi(app.url, () => dToken);
  await dapi.updateMe({ name: 'Mike R', email: 'mike@example.com', acceptTerms: true });
  await dapi.startDriver();
  await dapi.updateDriver({ legalName: 'Mike Romanenko', address: '1 Main St, Edmonton', dateOfBirth: '1985-01-01', homeCity: 'Edmonton', home: { lat: 53.5461, lng: -113.4938 } });
  await dapi.addVehicle({ type: 'pickup', make: 'Ram', model: '1500', year: 2020, plate: 'ABC123', registeredWeightKg: 3000, hasTrailer: true });
  const up = async () => (await drv.api.post('/v1/uploads?purpose=document', JPEG, { 'Content-Type': 'image/jpeg' })).key;
  for (const kind of ['license_front', 'license_back', 'registration', 'background_check']) await dapi.addDocument({ kind, fileKey: await up() });
  await dapi.addDocument({ kind: 'insurance_commercial', fileKey: await up(), insurer: 'Intact', policyNumber: 'X1', expiresOn: '2027-12-31' });
  await dapi.identity();
  await dapi.payouts();
  const quiz = await dapi.quiz();
  await dapi.agreement(Object.fromEntries(quiz.map((q) => [q.id, 0])));
  const sub = await dapi.submitDriver();
  assert.equal(sub.driver.status, 'pending');
  const did = (await dapi.me()).id;
  const sess = [...app.payments.identity.entries()].find(([, u]) => u === did)![0];
  await fetch(`${app.url}/webhooks/stripe`, { method: 'POST', body: JSON.stringify({ id: 'evt_m1', type: 'identity.verification_session.verified', data: { object: { id: sess } } }) });
  await dapi.refreshPayouts();
  const detail = await admin.api.get(`/v1/admin/drivers/${did}`);
  for (const d of detail.documents) await admin.api.post(`/v1/admin/documents/${d.id}/review`, { status: 'approved' });
  await admin.api.post(`/v1/admin/drivers/${did}/decision`, { status: 'approved', tier: 'pro', backgroundStatus: 'clear' });
  await dapi.saveTax({ type: 'sin', number: '046454286' });

  // the customer's screen flow
  const win = buildWindow(0, '00:00', '23:59')!;
  const ws = new Date(Math.max(Date.now() + 3_600_000, new Date(win.start).getTime())).toISOString();
  const we = new Date(new Date(ws).getTime() + 4 * 3_600_000).toISOString();
  const q = await api.quote({ pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 50000, insured: true, windowStart: ws, windowEnd: we });
  assert.equal(q.intercity, false);
  const created = await api.createOrder({ pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'L', declaredValueCents: 50000, insured: true, windowStart: ws, windowEnd: we, description: 'Шкаф', priceCents: 8000 });
  assert.equal(created.insuranceCents, 750);

  // the driver's screen flow
  const feed = await dapi.feed();
  const item = feed.items.find((i) => i.id === created.id)!;
  assert.equal(item.eligibility?.canTake, true);
  const offered = await dapi.offer(created.id, 9000);
  assert.equal(offered.offers[0]?.amountCents, 9000);
  const mine = await api.order(created.id);
  const off = mine.offers.find((f) => f.by === 'driver')!;
  const accepted = await api.respondOffer(created.id, off.id, 'accept');
  assert.equal(accepted.status, 'agreed');
  assert.equal(accepted.chargedCents, 9000 + 450 + 750);
  const sent = await api.sendMessage(created.id, 'мой телефон 780 555 1234');
  assert.equal(sent.contactHidden, true);
  assert.equal((await dapi.messages(created.id)).some((m) => m.from === 'them'), true);
  await dapi.enRoute(created.id);
  const pk = (await drv.api.post('/v1/uploads?purpose=pickup', JPEG, { 'Content-Type': 'image/jpeg' })).key;
  await dapi.pickup(created.id, [pk], undefined, { lat: 53.45, lng: -113.49 });
  await dapi.depart(created.id);
  const pin = (await api.order(created.id)).pin!;
  await assert.rejects(dapi.deliver(created.id, pin === '1234' ? '4321' : '1234'), (e: unknown) => e instanceof ApiError && e.code === 'wrong_pin' && (e.details as { attemptsLeft: number }).attemptsLeft === 9);
  const done = await dapi.deliver(created.id, pin);
  assert.equal(done.status, 'delivered');
  assert.ok(done.paidOutAt);
  await api.rate(created.id, 5);
  const earnings = await dapi.earnings();
  assert.equal(earnings.todayCents, 9000 - 450);
  const notes = await api.notifications();
  assert.ok(notes.some((n) => n.type === 'delivered'));
  const jobs = await dapi.jobs('history');
  assert.equal(jobs[0]?.id, created.id);

  // a trip, as published from the "I'm driving" tab
  const trip = await dapi.createTrip({ stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Red Deer', province: 'AB' }, { city: 'Calgary', province: 'AB' }], departAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), space: 'half' });
  assert.deepEqual((await dapi.trips()).map((t) => t.id), [trip.id]);
  const q2 = await api.quote({ pickup: places.whyteAve, dropoff: places.kensington, size: 'M', declaredValueCents: 1000, insured: false });
  assert.equal(q2.trips[0]?.tripId, trip.id);
  await dapi.cancelTrip(trip.id);
  dToken = null;
  await assert.rejects(dapi.trips(), (e: unknown) => e instanceof ApiError && e.status === 401);
});

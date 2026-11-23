import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { filterContacts } from '../src/lib/contactFilter.js';
import { decrypt, encrypt, signToken, verifyToken } from '../src/lib/crypto.js';
import { haversineKm, matchRoute, roadKm, sameCity } from '../src/lib/geo.js';
import { inQuietHours, normalizePhone } from '../src/lib/phone.js';
import { breakdown, cancelSplit, cargoLimitCents, insuranceCents, suggestPriceCents, tripPriceCents } from '../src/lib/pricing.js';
import { inlineParams } from '../src/db/psql.js';
import { stripeForm, verifyStripeSignature } from '../src/providers/payments.js';
import { presignGet } from '../src/providers/storage.js';
import { maxSizeFor, validSin } from '../src/services/drivers.js';
import { sizeFits } from '../src/services/trips.js';
import { CITIES, findCity } from '../src/data/cities.js';

const rules = loadConfig().rules;
const edm = findCity('Edmonton')!;
const rd = findCity('Red Deer')!;
const cgy = findCity('Calgary')!;

test('suggested prices follow the tariff table', () => {
  assert.equal(suggestPriceCents('L', 8, false), 7500); // city base, under 10 km
  assert.equal(suggestPriceCents('L', 20, false), 9000); // 75 + 10 km * 1.5
  assert.equal(suggestPriceCents('M', 300, true), 9500); // 30 + 300 * 0.22 = 96 -> 95
  assert.equal(suggestPriceCents('S', 1, false), 1500);
  assert.equal(tripPriceCents('M', 300, rules), 7500); // 20% off 95 = 76 -> 75
});

test('fees are 5% from each side and insurance is optional but always paid', () => {
  const b = breakdown(9000, false, 80000, rules);
  assert.deepEqual([b.clientFeeCents, b.driverFeeCents, b.insuranceCents, b.clientTotalCents, b.driverNetCents], [450, 450, 0, 9450, 8550]);
  assert.equal(insuranceCents(2000, rules), 300); // $20 cargo -> $3 minimum
  assert.equal(insuranceCents(250000, rules), 3750); // 1.5% of $2,500
  assert.equal(breakdown(9000, true, 2000, rules).clientTotalCents, 9750);
});

test('cancellation split by timing', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const base = { status: 'agreed', agreedCents: 15500, clientFeeCents: 775, insuranceCents: 0, chargedCents: 16275 };
  const late = cancelSplit({ ...base, windowStart: '2026-10-28T15:00:00Z' }, now, rules);
  assert.deepEqual(late, { tier: 'late', driverCents: 4650, platformCents: 1550, keptFeeCents: 775, refundCents: 9300 });
  const early = cancelSplit({ ...base, windowStart: '2026-10-31T15:00:00Z' }, now, rules);
  assert.equal(early.tier, 'early');
  assert.equal(early.driverCents, 775);
  assert.equal(early.refundCents, 16275 - 775 - 775 - 775);
  const setOff = cancelSplit({ ...base, windowStart: '2026-10-31T15:00:00Z' }, now, rules, { driverSetOff: true });
  assert.equal(setOff.tier, 'late');
  const free = cancelSplit({ ...base, status: 'open', agreedCents: null, chargedCents: null, windowStart: '2026-10-31T15:00:00Z' }, now, rules);
  assert.equal(free.tier, 'free');
  const noShow = cancelSplit({ ...base, windowStart: '2026-10-28T15:00:00Z' }, now, rules, { noShow: true });
  assert.equal(noShow.driverCents, 6200);
  // insurance premium is refunded when cancelled before pickup
  const ins = cancelSplit({ ...base, insuranceCents: 300, chargedCents: 16575, windowStart: '2026-10-31T15:00:00Z' }, now, rules);
  assert.equal(ins.refundCents, early.refundCents + 300);
});

test('cargo limits: basic $1,000, $5,000 with order insurance; Pro by policy', () => {
  assert.equal(cargoLimitCents({ tier: 'basic', cargoLimitCents: 100000 }, false, rules), 100000);
  assert.equal(cargoLimitCents({ tier: 'basic', cargoLimitCents: 100000 }, true, rules), 500000);
  assert.equal(cargoLimitCents({ tier: 'basic', cargoLimitCents: 250000 }, false, rules), 250000); // personal policy
  assert.equal(cargoLimitCents({ tier: 'pro', cargoLimitCents: 2500000 }, false, rules), Number.POSITIVE_INFINITY);
});

test('chat filter hides phones, emails, links and messengers but keeps normal text', () => {
  for (const s of ['call me 780 555 0123', 'мой номер +1 (780) 555-01-23', 'write to anna.k@gmail.com', 'see www.kijiji.ca/item', 'whatsapp me', 'пиши в телеграм', 'insta @anna_k22', '7 8 0 5 5 5 0 1 2 3', 'anna at gmail dot com']) {
    const r = filterContacts(s);
    assert.ok(r.hidden, s);
    assert.match(r.text, /\[contact hidden\]/, s);
  }
  for (const s of ['Буду в 14:30, третий подъезд', 'The sofa is 2.1 m long, 45 kg', 'Order #1024 is ready', 'Код от домофона 245']) {
    const r = filterContacts(s);
    assert.equal(r.hidden, false, s);
    assert.equal(r.text, s);
  }
});

test('JWT and AES-GCM', () => {
  const t = signToken('user-1', 'secret', 60);
  assert.equal(verifyToken(t, 'secret')?.sub, 'user-1');
  assert.equal(verifyToken(t, 'other'), null);
  assert.equal(verifyToken(t.slice(0, -2) + 'xx', 'secret'), null);
  assert.equal(verifyToken(signToken('u', 'secret', -10), 'secret'), null);
  const key = Buffer.alloc(32, 3).toString('base64');
  const blob = encrypt('046454286', key);
  assert.notEqual(blob, encrypt('046454286', key));
  assert.equal(decrypt(blob, key), '046454286');
});

test('geo: distances, same city, route matching through intermediate stops', () => {
  assert.ok(Math.abs(haversineKm(edm, cgy) - 280) < 10);
  assert.ok(roadKm(edm, cgy, 1.25) > 330);
  assert.ok(sameCity({ ...edm, city: 'Edmonton' }, { lat: 53.52, lng: -113.6, city: 'Edmonton', province: 'AB' }, 40));
  assert.ok(!sameCity({ ...edm }, { ...rd }, 40));
  const stops = [edm, rd, cgy];
  const m = matchRoute(stops, { lat: 53.5, lng: -113.5 }, rd, 30, 1.25);
  assert.deepEqual([m?.pickupIndex, m?.dropoffIndex], [0, 1]);
  assert.equal(matchRoute(stops, cgy, edm, 30, 1.25), null); // wrong direction
  assert.equal(matchRoute(stops, findCity('Saskatoon')!, cgy, 30, 1.25), null);
  assert.ok(CITIES.length > 50);
});

test('vehicle sizes', () => {
  assert.equal(maxSizeFor('pickup', false), 'L');
  assert.equal(maxSizeFor('pickup', true), 'XL');
  assert.equal(maxSizeFor('car_hauler', false), 'AUTO');
  assert.ok(sizeFits('XL', 'AUTO'));
  assert.ok(!sizeFits('AUTO', 'XL'));
  assert.ok(!sizeFits('XL', 'L'));
});

test('phones, SIN, quiet hours', () => {
  assert.equal(normalizePhone('(780) 555-0123'), '+17805550123');
  assert.equal(normalizePhone('1-780-555-0123'), '+17805550123');
  assert.equal(normalizePhone('555-0123'), null);
  assert.ok(validSin('046454286'));
  assert.ok(!validSin('046454287'));
  assert.ok(inQuietHours('23:30', '22:00', '07:00'));
  assert.ok(inQuietHours('06:59', '22:00', '07:00'));
  assert.ok(!inQuietHours('12:00', '22:00', '07:00'));
  assert.ok(!inQuietHours('12:00', null, null));
});

test('Stripe form encoding and webhook signature', () => {
  assert.equal(stripeForm({ amount: 100, metadata: { order_id: 'a b' }, list: ['card'] }), 'amount=100&metadata%5Border_id%5D=a%20b&list%5B0%5D=card');
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'account.updated', data: { object: {} } }));
  const t = 1_800_000_000;
  const sig = createHmac('sha256', secret).update(`${t}.${body.toString()}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 10)?.id, 'evt_1');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t + 1000), null);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=deadbeef`, secret, 300, t), null);
});

test('S3 presigned URL matches the AWS documentation example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = presignGet(
    { bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', virtualHost: 'examplebucket.s3.amazonaws.com' },
    'test.txt',
    86400,
    new Date('2013-05-24T00:00:00Z'),
  );
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('psql adapter quotes parameters safely', () => {
  assert.equal(inlineParams('SELECT $1, $2, $10', ["it's", null, 1, 2, 3, 4, 5, 6, 7, 8]), "SELECT 'it''s', NULL, 8");
  assert.equal(inlineParams('SELECT $1', [['a', 'b"c']]), `SELECT '{"a","b\\"c"}'`);
});

test('a re-uploaded document replaces the old one in the review checklist', async () => {
  const { checklist } = await import('../src/services/drivers.js');
  const doc = (kind: string, status: string, created_at: string) => ({ id: created_at, driver_id: 'd', kind, file_key: 'k', status, insurer: null, policy_number: null, coverage_cents: null, expires_on: null, note: null, created_at }) as never;
  const d = { identity_status: 'verified', background_status: 'clear' } as never;
  const docs = [doc('license_front', 'approved', '2026-11-19T20:00:00Z'), doc('license_front', 'pending', '2026-11-19T19:00:00Z')];
  const ready = checklist(d, [], docs, '2026-11-19').find((c) => c.key === 'documents_approved')!;
  assert.equal(ready.done, true, 'old pending copy does not block');
  const stale = checklist(d, [], [doc('license_front', 'pending', '2026-11-19T20:00:00Z'), doc('license_front', 'approved', '2026-11-19T19:00:00Z')], '2026-11-19').find((c) => c.key === 'documents_approved')!;
  assert.equal(stale.done, false, 'the newest upload still needs review');
});

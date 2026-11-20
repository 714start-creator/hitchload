// Test harness: a fresh Postgres database per test file, the real HTTP server
// on a random port, and stand-ins for Stripe, SMS and push.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, createContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/ctx.js';
import { createPsqlDb } from '../src/db/psql.js';
import { migrate } from '../src/db/migrate.js';
import { createMemoryHub } from '../src/http/realtime.js';
import { createFakePayments, type FakePayments } from '../src/providers/payments.js';
import { createLogPush, type PushMessage } from '../src/providers/push.js';
import { createLocalSms } from '../src/providers/sms.js';
import { createLocalStorage } from '../src/providers/storage.js';
import { createLogEmail, type EmailMessage } from '../src/providers/email.js';
import { createLogWebPush, type WebPushSubscription } from '../src/providers/webpush.js';

const PGHOST = process.env.TEST_PGHOST ?? '/tmp';
const PGPORT = process.env.TEST_PGPORT ?? '54329';
const PGUSER = process.env.TEST_PGUSER ?? 'postgres';

export const ADMIN_PHONE = '+17800000001';

export interface TestApp {
  url: string;
  ctx: Ctx;
  payments: FakePayments;
  pushes: PushMessage[];
  sms: { phone: string; text: string }[];
  hubEvents: { userId: string; type: string; data: unknown }[];
  emails: EmailMessage[];
  webPushes: { sub: WebPushSubscription; payload: object }[];
  /** move the app clock forward */
  advance(ms: number): void;
  close(): Promise<void>;
}

export async function startTestApp(name: string, opts: { realtime?: boolean } = {}): Promise<TestApp> {
  const db = `poputka_test_${name}_${process.pid}`;
  const psqlArgs = ['-h', PGHOST, '-p', PGPORT, '-U', PGUSER, '-q', '-v', 'ON_ERROR_STOP=1'];
  execFileSync('psql', [...psqlArgs, '-c', `DROP DATABASE IF EXISTS ${db}`, '-c', `CREATE DATABASE ${db}`], { stdio: 'pipe' });
  const dbUrl = `postgresql://${PGUSER}@/${db}?host=${encodeURIComponent(PGHOST)}&port=${PGPORT}`;

  process.env.NODE_ENV = 'test';
  process.env.ADMIN_PHONES = ADMIN_PHONE;
  const cfg = loadConfig();
  const conn = createPsqlDb(dbUrl);
  await migrate(conn, () => undefined);

  const payments = createFakePayments();
  const pushes: PushMessage[] = [];
  const sms: { phone: string; text: string }[] = [];
  const hubEvents: { userId: string; type: string; data: unknown }[] = [];
  const emails: EmailMessage[] = [];
  const webPushes: { sub: WebPushSubscription; payload: object }[] = [];
  let offset = 0;
  const ctx = createContext(cfg, conn, {
    payments,
    email: createLogEmail(emails),
    webPush: createLogWebPush(webPushes),
    push: createLogPush(pushes),
    sms: createLocalSms(conn, { exposeCode: true, log: () => undefined, sent: sms }),
    storage: createLocalStorage(mkdtempSync(path.join(tmpdir(), 'poputka-files-')), 'http://files.test', cfg.jwtSecret),
    hub: opts.realtime ? undefined : createMemoryHub(hubEvents),
    now: () => new Date(Date.now() + offset),
    log: (m, e) => { if (e) console.error(m, e); },
  });
  const server = createApp(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  // browser tests follow redirects to PUBLIC_URL (email links, Stripe returns): point it at this server
  if (opts.realtime) (ctx.cfg as { publicUrl: string }).publicUrl = `http://127.0.0.1:${port}`;
  return {
    url: `http://127.0.0.1:${port}`,
    ctx,
    payments,
    pushes,
    sms,
    hubEvents,
    emails,
    webPushes,
    advance: (ms) => void (offset += ms),
    async close() {
      await new Promise((r) => server.close(r));
      await conn.close();
      execFileSync('psql', [...psqlArgs, '-c', `DROP DATABASE IF EXISTS ${db}`], { stdio: 'pipe' });
    },
  };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: any) {
    super(`${status} ${body?.error?.code}: ${body?.error?.message}`);
  }
}

export function client(base: string, token?: string) {
  async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const isBuf = body instanceof Uint8Array;
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? (body as Uint8Array) : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }
  return {
    get: <T = any>(p: string) => call<T>('GET', p),
    post: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => call<T>('POST', p, b ?? {}, h),
    patch: <T = any>(p: string, b: unknown) => call<T>('PATCH', p, b),
    del: <T = any>(p: string, b?: unknown) => call<T>('DELETE', p, b),
    raw: call,
  };
}

export async function expectError(p: Promise<unknown>, status: number, code?: string): Promise<any> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status !== status || (code && e.body?.error?.code !== code)) throw new Error(`Expected ${status} ${code ?? ''}, got ${e.message}`);
    return e.body;
  }
  throw new Error(`Expected ${status} ${code ?? ''}, but the call succeeded`);
}

/** Sign in by phone with the dev SMS code. */
export async function signIn(app: TestApp, phone: string) {
  const anon = client(app.url);
  const start = await anon.post('/v1/auth/otp/start', { phone });
  const r = await anon.post('/v1/auth/otp/verify', { phone, code: start.devCode });
  return { token: r.token as string, user: r.user, api: client(app.url, r.token) };
}

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(300).fill(7), 0xff, 0xd9]);

export const places = {
  ikeaEdmonton: { address: '1311 102 St NW', city: 'Edmonton', province: 'AB', lat: 53.4475, lng: -113.4898 },
  secord: { address: '1025 Secord Promenade NW', city: 'Edmonton', province: 'AB', lat: 53.4878, lng: -113.6889 },
  whyteAve: { address: '10405 82 Ave NW', city: 'Edmonton', province: 'AB', lat: 53.5183, lng: -113.4963 },
  redDeer: { address: '4922 Ross St', city: 'Red Deer', province: 'AB', lat: 52.2681, lng: -113.8112 },
  kensington: { address: '1121 Kensington Rd NW', city: 'Calgary', province: 'AB', lat: 51.0526, lng: -114.0869 },
  saskatoon: { address: '201 21st St E', city: 'Saskatoon', province: 'SK', lat: 52.1279, lng: -106.6603 },
};


/** Registers and approves a driver through the real endpoints (admin approves). */
export async function onboardDriver(app: TestApp, phone: string, o: { name: string; tier: 'basic' | 'pro'; vehicle?: 'pickup' | 'cargo_van'; homeCity?: string; home?: { lat: number; lng: number }; radiusKm?: number; personalPolicy?: boolean; approve?: 'one-by-one' | 'all' | false }) {
  const admin = await signIn(app, ADMIN_PHONE);
  const s = await signIn(app, phone);
  const up = async () => (await s.api.post('/v1/uploads?purpose=document', JPEG, { 'Content-Type': 'image/jpeg' })).key as string;
  await s.api.patch('/v1/me', { name: o.name, email: `${o.name.split(' ')[0]!.toLowerCase()}${phone.slice(-4)}@example.com`, acceptTerms: true });
  await s.api.post('/v1/driver');
  await s.api.patch('/v1/driver', { legalName: o.name, address: '10220 104 Ave NW, Edmonton AB', dateOfBirth: '1988-04-12', homeCity: o.homeCity ?? 'Edmonton', home: o.home ?? { lat: 53.5461, lng: -113.4938 }, radiusKm: o.radiusKm ?? 50 });
  const vehicle = o.vehicle ?? 'pickup';
  await s.api.post('/v1/driver/vehicles', { type: vehicle, make: vehicle === 'pickup' ? 'Ram' : 'Ford', model: vehicle === 'pickup' ? '1500' : 'Transit', year: 2021, plate: 'CTX' + phone.slice(-4), registeredWeightKg: 3200, hasTrailer: false, equipment: ['straps'] });
  const docs: Record<string, unknown>[] = [
    { kind: 'license_front' }, { kind: 'license_back' }, { kind: 'registration' }, { kind: 'background_check' }, { kind: 'vehicle_side' }, { kind: 'vehicle_rear' },
    o.personalPolicy
      ? { kind: 'insurance_auto', insurer: 'Intact', policyNumber: 'A-' + phone.slice(-4), expiresOn: '2027-06-30', riskAck: true }
      : { kind: o.tier === 'pro' ? 'insurance_commercial' : 'insurance_endorsement', insurer: 'Intact', policyNumber: 'P-' + phone.slice(-4), expiresOn: '2027-06-30' },
  ];
  if (o.tier === 'pro') docs.push({ kind: 'insurance_cargo', insurer: 'Aviva', policyNumber: 'C-1', coverageCents: 2_500_000, expiresOn: '2027-06-30' });
  for (const d of docs) await s.api.post('/v1/driver/documents', { ...d, fileKey: await up() });
  await s.api.post('/v1/driver/identity');
  await s.api.post('/v1/driver/payouts');
  const quiz = await s.api.get('/v1/driver/quiz');
  await s.api.post('/v1/driver/agreement', { answers: Object.fromEntries(quiz.map((q: { id: string }) => [q.id, 0])) });
  await s.api.post('/v1/driver/submit');
  const me = await s.api.get('/v1/me');
  const sessionId = [...app.payments.identity.entries()].find(([, u]) => u === me.id)![0];
  await client(app.url).post('/webhooks/stripe', { id: 'evt_id_' + phone, type: 'identity.verification_session.verified', data: { object: { id: sessionId, metadata: { user_id: me.id } } } });
  await s.api.post('/v1/driver/payouts/refresh');
  if (o.approve === 'all') await admin.api.post(`/v1/admin/drivers/${me.id}/approve-all`, { tier: o.tier });
  else if (o.approve !== false) {
    const detail = await admin.api.get(`/v1/admin/drivers/${me.id}`);
    for (const d of detail.documents) await admin.api.post(`/v1/admin/documents/${d.id}/review`, { status: 'approved' });
    await admin.api.post(`/v1/admin/drivers/${me.id}/decision`, { status: 'approved', tier: o.tier });
  }
  return { ...s, id: me.id as string };
}

/** A customer with name, email, accepted terms and a saved card. */
export async function customer(app: TestApp, phone: string, name = 'Test Customer') {
  const s = await signIn(app, phone);
  await s.api.patch('/v1/me', { name, email: `${name.split(' ')[0]!.toLowerCase()}${phone.slice(-4)}@example.com`, acceptTerms: true });
  const setup = await s.api.post('/v1/me/card/setup');
  app.payments.addCard(setup.customerId);
  await s.api.post('/v1/me/card/sync');
  return s;
}

/** Follows the link in the last confirmation email sent to `to`. */
export async function confirmEmail(app: TestApp, to: string) {
  const m = [...app.emails].reverse().find((e) => e.to === to && /confirm|подтверд/i.test(e.subject));
  if (!m) throw new Error(`no confirmation email to ${to}`);
  const url = /(https?:\/\/[^\s"]+\/v1\/auth\/email\/verify\?[^\s"<]+)/.exec(m.text)![1]!;
  const path = url.replace(app.ctx.cfg.publicUrl, '');
  return fetch(app.url + path, { redirect: 'manual' });
}

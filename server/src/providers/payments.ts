// Payments: Stripe (customers + saved cards, PaymentIntents, Connect Express
// payouts, Identity) behind one interface, plus an in-memory fake for dev/tests.
import { createHmac, randomUUID } from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';

export interface CardInfo {
  paymentMethodId: string;
  brand: string;
  last4: string;
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string; chargeId: string }
  | { ok: false; error: string; paymentIntentId?: string };

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export interface Payments {
  readonly kind: 'stripe' | 'fake';
  ensureCustomer(u: { id: string; phone: string; name: string | null; email: string | null; stripeCustomerId: string | null }): Promise<string>;
  /** Everything the mobile PaymentSheet needs to save a card (setup mode). */
  createCardSetup(customerId: string): Promise<{ setupIntentClientSecret: string; ephemeralKeySecret: string; customerId: string }>;
  /** Most recent saved card; also makes it the customer's default. */
  latestCard(customerId: string): Promise<CardInfo | null>;
  charge(a: { customerId: string; paymentMethodId: string; amountCents: number; orderId: string; orderNumber: number; idempotencyKey: string }): Promise<ChargeResult>;
  refund(a: { paymentIntentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string }>;
  transfer(a: { accountId: string; amountCents: number; chargeId: string; orderId: string; idempotencyKey: string }): Promise<{ transferId: string }>;
  createConnectedAccount(a: { userId: string; email: string | null; phone: string }): Promise<string>;
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  accountPayoutsEnabled(accountId: string): Promise<boolean>;
  createIdentitySession(a: { userId: string; returnUrl: string }): Promise<{ id: string; url: string; clientSecret: string }>;
  parseWebhook(raw: Buffer, signature: string | undefined): StripeEvent | null;
}

// ---------------------------------------------------------------- Stripe (REST)

const API = 'https://api.stripe.com/v1';
const VERSION = '2024-06-20';

function form(obj: Record<string, unknown>, prefix = '', out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}
export const stripeForm = (obj: Record<string, unknown>) => form(obj).join('&');

class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly body: any) {
    super(message);
  }
}

export function createStripePayments(secretKey: string, webhookSecret: string | undefined): Payments {
  async function call<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>, opts: { idempotencyKey?: string; version?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': opts.version ?? VERSION,
    };
    let url = API + path;
    let body: string | undefined;
    if (params && method === 'GET') url += '?' + stripeForm(params);
    else if (params) {
      body = stripeForm(params);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const res = await fetch(url, { method, headers, body });
    const json = (await res.json()) as any;
    if (!res.ok) throw new StripeError(json?.error?.message ?? `Stripe ${res.status}`, res.status, json);
    return json as T;
  }

  return {
    kind: 'stripe',
    async ensureCustomer(u) {
      if (u.stripeCustomerId) return u.stripeCustomerId;
      const c = await call('POST', '/customers', { phone: u.phone, name: u.name ?? undefined, email: u.email ?? undefined, metadata: { user_id: u.id } }, { idempotencyKey: `customer-${u.id}` });
      return c.id as string;
    },
    async createCardSetup(customerId) {
      const ek = await call('POST', '/ephemeral_keys', { customer: customerId });
      const si = await call('POST', '/setup_intents', { customer: customerId, usage: 'off_session', payment_method_types: ['card'] });
      return { setupIntentClientSecret: si.client_secret, ephemeralKeySecret: ek.secret, customerId };
    },
    async latestCard(customerId) {
      const list = await call('GET', '/payment_methods', { customer: customerId, type: 'card', limit: 1 });
      const pm = list.data?.[0];
      if (!pm) return null;
      await call('POST', `/customers/${customerId}`, { invoice_settings: { default_payment_method: pm.id } });
      return { paymentMethodId: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '????' };
    },
    async charge(a) {
      try {
        const pi = await call(
          'POST',
          '/payment_intents',
          {
            amount: a.amountCents,
            currency: 'cad',
            customer: a.customerId,
            payment_method: a.paymentMethodId,
            off_session: true,
            confirm: true,
            transfer_group: `order_${a.orderId}`,
            description: `Hitchload order #${a.orderNumber}`,
            metadata: { order_id: a.orderId },
          },
          { idempotencyKey: a.idempotencyKey },
        );
        if (pi.status === 'requires_action') return { ok: false, error: 'authentication_required', paymentIntentId: pi.id };
        if (pi.status !== 'succeeded') return { ok: false, error: `payment_${pi.status}`, paymentIntentId: pi.id };
        return { ok: true, paymentIntentId: pi.id, chargeId: pi.latest_charge as string };
      } catch (e) {
        if (e instanceof StripeError) {
          return { ok: false, error: e.body?.error?.decline_code ?? e.body?.error?.code ?? 'card_error', paymentIntentId: e.body?.error?.payment_intent?.id };
        }
        throw e;
      }
    },
    async refund(a) {
      const r = await call('POST', '/refunds', { payment_intent: a.paymentIntentId, amount: a.amountCents }, { idempotencyKey: a.idempotencyKey });
      return { refundId: r.id };
    },
    async transfer(a) {
      const t = await call(
        'POST',
        '/transfers',
        { amount: a.amountCents, currency: 'cad', destination: a.accountId, source_transaction: a.chargeId, transfer_group: `order_${a.orderId}`, metadata: { order_id: a.orderId } },
        { idempotencyKey: a.idempotencyKey },
      );
      return { transferId: t.id };
    },
    async createConnectedAccount(a) {
      const acct = await call(
        'POST',
        '/accounts',
        {
          type: 'express',
          country: 'CA',
          email: a.email ?? undefined,
          business_type: 'individual',
          capabilities: { transfers: { requested: true } },
          business_profile: { mcc: '4215', product_description: 'Independent delivery driver on the Hitchload platform' },
          metadata: { user_id: a.userId },
        },
        { idempotencyKey: `account-${a.userId}` },
      );
      return acct.id as string;
    },
    async onboardingLink(accountId, returnUrl, refreshUrl) {
      const link = await call('POST', '/account_links', { account: accountId, return_url: returnUrl, refresh_url: refreshUrl, type: 'account_onboarding' });
      return link.url as string;
    },
    async accountPayoutsEnabled(accountId) {
      const acct = await call('GET', `/accounts/${accountId}`);
      return Boolean(acct.payouts_enabled);
    },
    async createIdentitySession(a) {
      const s = await call('POST', '/identity/verification_sessions', {
        type: 'document',
        options: { document: { require_matching_selfie: true, allowed_types: ['driving_license'] } },
        metadata: { user_id: a.userId },
        return_url: a.returnUrl,
      });
      return { id: s.id, url: s.url, clientSecret: s.client_secret };
    },
    parseWebhook(raw, signature) {
      if (!webhookSecret || !signature) return null;
      return verifyStripeSignature(raw, signature, webhookSecret);
    },
  };
}

/** Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${payload}`)) */
export function verifyStripeSignature(raw: Buffer, header: string, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): StripeEvent | null {
  const parts = Object.create(null) as Record<string, string[]>;
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim();
    (parts[k] ??= []).push(kv.slice(i + 1).trim());
  }
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return null;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  if (!(parts.v1 ?? []).some((sig) => safeEqual(sig, expected))) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as StripeEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Fake

export interface FakePayments extends Payments {
  calls: { op: string; args: unknown }[];
  /** cards per customer; a card whose last4 is '0002' always declines */
  cards: Map<string, CardInfo>;
  addCard(customerId: string, last4?: string): CardInfo;
  accountsReady: Set<string>;
  identity: Map<string, string>; // sessionId -> userId
}

export function createFakePayments(): FakePayments {
  const calls: { op: string; args: unknown }[] = [];
  const cards = new Map<string, CardInfo>();
  const accountsReady = new Set<string>();
  const identity = new Map<string, string>();
  const rec = (op: string, args: unknown) => calls.push({ op, args });
  const fake: FakePayments = {
    kind: 'fake',
    calls,
    cards,
    accountsReady,
    identity,
    addCard(customerId, last4 = '4242') {
      const c = { paymentMethodId: `pm_fake_${randomUUID().slice(0, 8)}`, brand: 'visa', last4 };
      cards.set(customerId, c);
      return c;
    },
    async ensureCustomer(u) {
      rec('ensureCustomer', u.id);
      return u.stripeCustomerId ?? `cus_fake_${u.id.slice(0, 8)}`;
    },
    async createCardSetup(customerId) {
      rec('createCardSetup', customerId);
      return { setupIntentClientSecret: `seti_fake_${customerId}_secret`, ephemeralKeySecret: 'ek_fake', customerId };
    },
    async latestCard(customerId) {
      return cards.get(customerId) ?? null;
    },
    async charge(a) {
      rec('charge', a);
      const card = [...cards.values()].find((c) => c.paymentMethodId === a.paymentMethodId);
      // test cards live in memory; after a server restart a saved test card (pm_fake_…) is still valid
      const known = card ?? (a.paymentMethodId.startsWith('pm_fake_') ? { last4: '4242' } : null);
      if (!known) return { ok: false, error: 'card_missing', paymentIntentId: `pi_fake_${a.idempotencyKey}` };
      if (known.last4 === '0002') return { ok: false, error: 'card_declined', paymentIntentId: `pi_fake_${a.idempotencyKey}` };
      if (known.last4 === '9995') return { ok: false, error: 'insufficient_funds', paymentIntentId: `pi_fake_${a.idempotencyKey}` };
      return { ok: true, paymentIntentId: `pi_fake_${a.orderId.slice(0, 8)}_${calls.length}`, chargeId: `ch_fake_${calls.length}` };
    },
    async refund(a) {
      rec('refund', a);
      return { refundId: `re_fake_${calls.length}` };
    },
    async transfer(a) {
      rec('transfer', a);
      return { transferId: `tr_fake_${calls.length}` };
    },
    async createConnectedAccount(a) {
      rec('createConnectedAccount', a.userId);
      return `acct_fake_${a.userId.slice(0, 8)}`;
    },
    async onboardingLink(accountId) {
      accountsReady.add(accountId); // dev: onboarding completes instantly
      return `https://connect.stripe.test/onboarding/${accountId}`;
    },
    async accountPayoutsEnabled(accountId) {
      return accountsReady.has(accountId);
    },
    async createIdentitySession(a) {
      const id = `vs_fake_${a.userId.slice(0, 8)}`;
      identity.set(id, a.userId);
      return { id, url: `https://verify.stripe.test/${id}`, clientSecret: `${id}_secret` };
    },
    parseWebhook(raw) {
      try {
        return JSON.parse(raw.toString('utf8')) as StripeEvent;
      } catch {
        return null;
      }
    },
  };
  return fake;
}

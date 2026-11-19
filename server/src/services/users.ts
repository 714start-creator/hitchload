import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { maybeOne, one } from '../db/db.js';
import { safeEqual, sha256, signToken, verifyToken } from '../lib/crypto.js';
import { layout } from '../providers/email.js';
import { isValidSubscription } from '../providers/webpush.js';
import { bad, HttpError } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import type { AuthUser } from '../http/router.js';
import { userDto, type DriverRow, type UserRow } from './dto.js';

export async function startOtp(ctx: Ctx, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw bad('invalid_phone', 'Enter a 10-digit Canadian or US number');
  const r = await ctx.sms.start(phone);
  return { phone, devCode: ctx.cfg.prod ? undefined : r.devCode };
}

export async function verifyOtp(ctx: Ctx, rawPhone: string, code: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw bad('invalid_phone', 'Enter a 10-digit Canadian or US number');
  if (!(await ctx.sms.check(phone, code.trim()))) throw new HttpError(400, 'invalid_code', 'The code is wrong or has expired');
  const isAdmin = ctx.cfg.adminPhones.includes(phone);
  const user = await one<UserRow>(
    ctx.db,
    `INSERT INTO users(phone, is_admin) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET is_admin = users.is_admin OR EXCLUDED.is_admin
     RETURNING *`,
    [phone, isAdmin],
  );
  if (user.blocked) throw new HttpError(403, 'account_blocked', 'This account is blocked');
  const driver = await maybeOne<DriverRow>(ctx.db, 'SELECT * FROM drivers WHERE user_id = $1', [user.id]);
  return { token: signToken(user.id, ctx.cfg.jwtSecret), user: userDto(user, driver) };
}

export async function authenticate(ctx: Ctx, token: string): Promise<AuthUser | null> {
  const claims = verifyToken(token, ctx.cfg.jwtSecret);
  if (!claims) return null;
  const u = await maybeOne<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [claims.sub]);
  if (!u) return null;
  return { id: u.id, phone: u.phone, name: u.name, email: u.email, lang: u.lang, isAdmin: u.is_admin, blocked: u.blocked };
}

export async function getMe(ctx: Ctx, userId: string) {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  const d = await maybeOne<DriverRow>(ctx.db, 'SELECT * FROM drivers WHERE user_id = $1', [userId]);
  return userDto(u, d);
}

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(120).optional(),
  lang: z.enum(['ru', 'en', 'uk', 'fr']).optional(),
  acceptTerms: z.literal(true).optional(),
  emailAlerts: z.boolean().optional(),
});

export async function updateProfile(ctx: Ctx, userId: string, p: z.infer<typeof profileSchema>) {
  const before = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  const email = p.email?.toLowerCase();
  const emailChanged = email !== undefined && email !== before.email;
  await ctx.db.query(
    `UPDATE users SET name = coalesce($2, name), email = coalesce($3, email), lang = coalesce($4, lang),
       terms_accepted_at = CASE WHEN $5 THEN coalesce(terms_accepted_at, now()) ELSE terms_accepted_at END,
       email_alerts = coalesce($6, email_alerts),
       email_verified_at = CASE WHEN $7 THEN NULL ELSE email_verified_at END
     WHERE id = $1`,
    [userId, p.name ?? null, email ?? null, p.lang ?? null, p.acceptTerms === true, p.emailAlerts ?? null, emailChanged],
  );
  if (emailChanged) await sendEmailVerification(ctx, userId).catch((e) => ctx.log('verification email failed', e));
  return getMe(ctx, userId);
}

// ---------------------------------------------------------------- email confirmation

export async function sendEmailVerification(ctx: Ctx, userId: string) {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!u.email) throw bad('no_email', 'Add your email first');
  if (u.email_verified_at) return { sent: false, alreadyVerified: true };
  const token = randomBytes(24).toString('base64url');
  await ctx.db.query(`UPDATE users SET email_token_hash = $2, email_token_expires = now() + interval '3 days' WHERE id = $1`, [userId, sha256(token)]);
  const ru = u.lang === 'ru';
  const url = `${ctx.cfg.publicUrl}/v1/auth/email/verify?u=${u.id}&t=${token}`;
  const m = layout({
    brand: ctx.cfg.brand,
    title: ru ? 'Подтвердите email' : 'Confirm your email',
    body: ru
      ? `Нажмите кнопку, чтобы подтвердить адрес ${u.email}. На него будут приходить чеки и подтверждения заказов.\nЕсли вы не регистрировались на ${ctx.cfg.brand}, просто удалите это письмо.`
      : `Tap the button to confirm ${u.email}. We send receipts and order confirmations here.\nIf you did not sign up for ${ctx.cfg.brand}, ignore this email.`,
    button: { text: ru ? 'Подтвердить email' : 'Confirm email', url },
    footer: `${ctx.cfg.brand} · ${ctx.cfg.supportEmail}`,
  });
  await ctx.email.send({ to: u.email, subject: ru ? `Подтвердите email для ${ctx.cfg.brand}` : `Confirm your email for ${ctx.cfg.brand}`, html: m.html, text: m.text });
  return { sent: true, alreadyVerified: false };
}

/** Link from the confirmation email. Returns the site path to redirect to. */
export async function verifyEmail(ctx: Ctx, userId: string, token: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return '/account?email=invalid';
  const u = await maybeOne<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!u) return '/account?email=invalid';
  if (u.email_verified_at) return '/account?email=verified';
  if (!u.email_token_hash || !u.email_token_expires || new Date(u.email_token_expires) < ctx.now() || !safeEqual(u.email_token_hash, sha256(token))) return '/account?email=expired';
  await ctx.db.query('UPDATE users SET email_verified_at = now(), email_token_hash = NULL, email_token_expires = NULL WHERE id = $1', [userId]);
  return '/account?email=verified';
}

/** Signed one-click links in emails (alert unsubscribe). */
export const linkSig = (ctx: Ctx, data: string) => createHmac('sha256', ctx.cfg.jwtSecret).update(data).digest('base64url').slice(0, 32);

export async function savePushToken(ctx: Ctx, userId: string, token: string, platform: string) {
  if (platform === 'web') {
    let sub: unknown;
    try {
      sub = JSON.parse(token);
    } catch {
      throw bad('invalid_push_token');
    }
    if (!isValidSubscription(sub)) throw bad('invalid_push_token');
    token = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  } else if (!/^(Expo|Exponent)PushToken\[.+\]$/.test(token)) throw bad('invalid_push_token');
  await ctx.db.query(
    `INSERT INTO push_tokens(token, user_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
    [token, userId, platform],
  );
}

export async function removePushToken(ctx: Ctx, userId: string, token: string) {
  let endpoint: string | null = null;
  try {
    endpoint = (JSON.parse(token) as { endpoint?: string }).endpoint ?? null;
  } catch {
    /* app token */
  }
  if (endpoint) {
    const prefix = `{"endpoint":${JSON.stringify(endpoint)},`;
    await ctx.db.query('DELETE FROM push_tokens WHERE left(token, length($1)) = $1 AND user_id = $2', [prefix, userId]);
    return;
  }
  await ctx.db.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, userId]);
}

/** Starts saving a card: creates the Stripe customer and returns PaymentSheet secrets. */
export async function startCardSetup(ctx: Ctx, userId: string) {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  const customerId = await ctx.payments.ensureCustomer({ id: u.id, phone: u.phone, name: u.name, email: u.email, stripeCustomerId: u.stripe_customer_id });
  if (customerId !== u.stripe_customer_id) await ctx.db.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [userId, customerId]);
  const s = await ctx.payments.createCardSetup(customerId);
  return { ...s, publishableKey: ctx.cfg.stripe.publishableKey, merchantDisplayName: ctx.cfg.brand };
}

/** After the PaymentSheet finishes: read the saved card from Stripe. */
export async function syncCard(ctx: Ctx, userId: string) {
  const u = await one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!u.stripe_customer_id) throw bad('no_card', 'Add a card first');
  const card = await ctx.payments.latestCard(u.stripe_customer_id);
  if (!card) throw bad('no_card', 'No card was saved');
  await ctx.db.query('UPDATE users SET payment_method_id = $2, card_brand = $3, card_last4 = $4 WHERE id = $1', [userId, card.paymentMethodId, card.brand, card.last4]);
  return getMe(ctx, userId);
}

export async function listNotifications(ctx: Ctx, userId: string, before?: number) {
  const rows = await ctx.db.query<{ id: number; type: string; order_id: string | null; data: Record<string, unknown>; read_at: string | null; created_at: string }>(
    `SELECT * FROM notifications WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 50`,
    [userId, before ?? null],
  );
  return rows.map((n) => ({ id: n.id, type: n.type, orderId: n.order_id, title: n.data.title, body: n.data.body, link: n.data.link ?? null, read: Boolean(n.read_at), createdAt: n.created_at }));
}

export async function markNotificationsRead(ctx: Ctx, userId: string, upTo: number) {
  await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id <= $2 AND read_at IS NULL', [userId, upTo]);
}

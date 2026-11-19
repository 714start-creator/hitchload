// Driver onboarding, documents, vehicles, payouts setup and admin review.
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { maybeOne, one, type Queryable } from '../db/db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { bad, conflict, forbidden, notFound } from '../lib/errors.js';
import { driverSelfDto, type DriverRow } from './dto.js';
import { notify, notifyAdmins } from './notify.js';

export const DOC_KINDS = [
  'license_front', 'license_back', 'registration',
  'insurance_auto', 'insurance_endorsement', 'insurance_commercial', 'insurance_cargo', 'insurance_car_hauling',
  'safety_fitness_certificate', 'background_check', 'other',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];
const INSURANCE_KINDS: DocKind[] = ['insurance_auto', 'insurance_endorsement', 'insurance_commercial', 'insurance_cargo', 'insurance_car_hauling'];
/** A policy that covers driving for pay. A plain personal policy does not. */
const DELIVERY_COVER: DocKind[] = ['insurance_endorsement', 'insurance_commercial'];

export interface DocRow {
  id: string;
  driver_id: string;
  kind: DocKind;
  file_key: string;
  status: 'pending' | 'approved' | 'rejected';
  insurer: string | null;
  policy_number: string | null;
  coverage_cents: number | null;
  expires_on: string | null;
  note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface VehicleRow {
  id: string;
  driver_id: string;
  type: string;
  make: string;
  model: string;
  year: number;
  plate: string;
  province: string;
  registered_weight_kg: number;
  cargo_length_cm: number | null;
  has_trailer: boolean;
  max_size: 'S' | 'M' | 'L' | 'XL' | 'AUTO';
  equipment: string[];
  active: boolean;
}

export async function getDriver(q: Queryable, userId: string): Promise<DriverRow> {
  const d = await maybeOne<DriverRow>(q, 'SELECT * FROM drivers WHERE user_id = $1', [userId]);
  if (!d) throw notFound('Driver profile not found. Start driver registration first');
  return d;
}

export async function startDriver(ctx: Ctx, userId: string) {
  await ctx.db.query('INSERT INTO drivers(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  return driverOverview(ctx, userId);
}

export const driverProfileSchema = z.object({
  legalName: z.string().trim().min(3).max(120).optional(),
  address: z.string().trim().min(5).max(200).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  homeCity: z.string().trim().min(2).max(80).optional(),
  home: z.object({ lat: z.number().min(41).max(84), lng: z.number().min(-142).max(-52) }).optional(),
  radiusKm: z.number().int().min(5).max(300).optional(),
  quietFrom: z.string().regex(/^\d\d:\d\d$/).nullable().optional(),
  quietTo: z.string().regex(/^\d\d:\d\d$/).nullable().optional(),
});

export async function updateDriverProfile(ctx: Ctx, userId: string, p: z.infer<typeof driverProfileSchema>) {
  const d = await getDriver(ctx.db, userId);
  if (p.dateOfBirth) {
    const age = (ctx.now().getTime() - new Date(p.dateOfBirth + 'T00:00:00Z').getTime()) / (365.25 * 86_400_000);
    if (age < 18) throw bad('too_young', 'Drivers must be at least 18');
  }
  const identityFields = p.legalName !== undefined || p.dateOfBirth !== undefined;
  if (identityFields && (d.status === 'approved' || d.status === 'pending')) throw conflict('locked', 'Name and date of birth can only be changed by support after review');
  await ctx.db.query(
    `UPDATE drivers SET
       legal_name = coalesce($2, legal_name), address = coalesce($3, address), date_of_birth = coalesce($4::date, date_of_birth),
       home_city = coalesce($5, home_city), home_lat = coalesce($6, home_lat), home_lng = coalesce($7, home_lng),
       radius_km = coalesce($8, radius_km),
       quiet_from = CASE WHEN $9 THEN $10 ELSE quiet_from END,
       quiet_to = CASE WHEN $9 THEN $11 ELSE quiet_to END
     WHERE user_id = $1`,
    [userId, p.legalName ?? null, p.address ?? null, p.dateOfBirth ?? null, p.homeCity ?? null, p.home?.lat ?? null, p.home?.lng ?? null, p.radiusKm ?? null,
      p.quietFrom !== undefined || p.quietTo !== undefined, p.quietFrom ?? null, p.quietTo ?? null],
  );
  return driverOverview(ctx, userId);
}

export const vehicleSchema = z.object({
  type: z.enum(['car', 'suv', 'pickup', 'van', 'cargo_van', 'box_truck', 'tow_truck', 'car_hauler']),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(40),
  year: z.number().int().min(1990).max(2100),
  plate: z.string().trim().min(2).max(12),
  province: z.string().length(2).default('AB'),
  registeredWeightKg: z.number().int().min(500).max(40_000),
  cargoLengthCm: z.number().int().min(30).max(2000).optional(),
  hasTrailer: z.boolean().default(false),
  equipment: z.array(z.enum(['straps', 'blankets', 'dolly', 'winch', 'ramps', 'tarp', 'liftgate'])).max(10).default([]),
});

/** Largest size class a vehicle type can take by default. */
export function maxSizeFor(type: string, hasTrailer: boolean): VehicleRow['max_size'] {
  if (type === 'tow_truck' || type === 'car_hauler') return 'AUTO';
  if (type === 'box_truck' || type === 'cargo_van') return 'XL';
  if (type === 'pickup' || type === 'van') return hasTrailer ? 'XL' : 'L';
  if (type === 'suv') return 'M';
  return hasTrailer ? 'L' : 'M';
}

export async function addVehicle(ctx: Ctx, userId: string, v: z.infer<typeof vehicleSchema>) {
  await getDriver(ctx.db, userId);
  const row = await one<VehicleRow>(
    ctx.db,
    `INSERT INTO vehicles(driver_id, type, make, model, year, plate, province, registered_weight_kg, cargo_length_cm, has_trailer, max_size, equipment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [userId, v.type, v.make, v.model, v.year, v.plate.toUpperCase(), v.province.toUpperCase(), v.registeredWeightKg, v.cargoLengthCm ?? null, v.hasTrailer, maxSizeFor(v.type, v.hasTrailer), v.equipment],
  );
  return vehicleDto(row);
}

export async function removeVehicle(ctx: Ctx, userId: string, vehicleId: string) {
  await ctx.db.query('UPDATE vehicles SET active = false WHERE id = $1 AND driver_id = $2', [vehicleId, userId]);
}

export const vehicleDto = (v: VehicleRow) => ({
  id: v.id, type: v.type, make: v.make, model: v.model, year: v.year, plate: v.plate, province: v.province,
  registeredWeightKg: v.registered_weight_kg, cargoLengthCm: v.cargo_length_cm, hasTrailer: v.has_trailer, maxSize: v.max_size, equipment: v.equipment,
  needsFederalSfc: v.registered_weight_kg > 4500,
});

export const documentSchema = z.object({
  kind: z.enum(DOC_KINDS),
  fileKey: z.string().min(5).max(300),
  insurer: z.string().trim().max(80).optional(),
  policyNumber: z.string().trim().max(60).optional(),
  coverageCents: z.number().int().min(0).max(1_000_000_00).optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function addDocument(ctx: Ctx, userId: string, p: z.infer<typeof documentSchema>) {
  await getDriver(ctx.db, userId);
  if (!p.fileKey.startsWith(`u/${userId}/`)) throw forbidden('That file does not belong to you');
  if (INSURANCE_KINDS.includes(p.kind)) {
    if (!p.insurer || !p.policyNumber || !p.expiresOn) throw bad('insurance_details_required', 'Insurer, policy number and expiry date are required');
    if (p.expiresOn <= ctx.now().toISOString().slice(0, 10)) throw bad('policy_expired', 'This policy has already expired');
    if ((p.kind === 'insurance_cargo' || p.kind === 'insurance_car_hauling') && !p.coverageCents) throw bad('coverage_required', 'Enter the cargo coverage limit');
  }
  const row = await one<DocRow>(
    ctx.db,
    `INSERT INTO documents(driver_id, kind, file_key, insurer, policy_number, coverage_cents, expires_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, p.kind, p.fileKey, p.insurer ?? null, p.policyNumber ?? null, p.coverageCents ?? null, p.expiresOn ?? null],
  );
  return docDto(row);
}

export const docDto = (d: DocRow, url?: string) => ({
  id: d.id, kind: d.kind, status: d.status, insurer: d.insurer, policyNumber: d.policy_number, coverageCents: d.coverage_cents,
  expiresOn: d.expires_on, note: d.note, createdAt: d.created_at, url,
});

// ---------------------------------------------------------------- tax info (CRA reporting)

/** Luhn check used by Canadian SINs. */
export function validSin(sin: string): boolean {
  if (!/^\d{9}$/.test(sin) || sin.startsWith('8')) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(sin[i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export const taxSchema = z.object({
  type: z.enum(['sin', 'bn']),
  number: z.string().trim().max(20),
  gstNumber: z.string().trim().max(20).optional(),
});

export async function saveTaxInfo(ctx: Ctx, userId: string, p: z.infer<typeof taxSchema>) {
  await getDriver(ctx.db, userId);
  const digits = p.number.replace(/\D/g, '');
  if (p.type === 'sin' && !validSin(digits)) throw bad('invalid_sin', 'This SIN is not valid');
  if (p.type === 'bn' && digits.length !== 9 && digits.length !== 13) throw bad('invalid_bn', 'A business number has 9 digits');
  await ctx.db.query(
    `UPDATE drivers SET tax_id_type = $2, tax_id_enc = $3, tax_id_last3 = $4, gst_number = $5 WHERE user_id = $1`,
    [userId, p.type, encrypt(digits, ctx.cfg.dataKey), digits.slice(-3), p.gstNumber ?? null],
  );
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target) VALUES ($1, 'tax_info_saved', $2)`, [userId, userId]);
  // release payouts that were waiting for this
  const { retryHeldPayouts } = await import('./payouts.js');
  await retryHeldPayouts(ctx, userId);
  return driverOverview(ctx, userId);
}

export function revealTaxId(ctx: Ctx, d: DriverRow): string | null {
  return d.tax_id_enc ? decrypt(d.tax_id_enc, ctx.cfg.dataKey) : null;
}

// ---------------------------------------------------------------- agreement & quiz

export const QUIZ = [
  { id: 'pin', ru: 'Когда можно отдать груз?', en: 'When may you hand over the cargo?', options: { ru: ['Когда получатель назвал PIN', 'Когда получатель назвал имя', 'Оставить у двери'], en: ['When the recipient gives the PIN', 'When the recipient says their name', 'Leave it at the door'] }, answer: 0 },
  { id: 'photo', ru: 'Что сделать при погрузке?', en: 'What do you do at pickup?', options: { ru: ['Сфотографировать груз со всех сторон', 'Ничего', 'Написать клиенту в мессенджер'], en: ['Photograph the cargo from all sides', 'Nothing', 'Message the customer on WhatsApp'] }, answer: 0 },
  { id: 'damage', ru: 'Груз повреждён при погрузке — что делать?', en: 'The cargo is damaged at pickup. What do you do?', options: { ru: ['Отметить повреждения на фото до отъезда', 'Молча везти', 'Отменить без объяснений'], en: ['Mark the damage on photos before leaving', 'Drive off without a word', 'Cancel without a reason'] }, answer: 0 },
  { id: 'contact', ru: 'Клиент просит перейти на оплату наличными мимо приложения', en: 'The customer asks to pay cash outside the app', options: { ru: ['Отказаться: оплата только в приложении', 'Согласиться', 'Взять половину наличными'], en: ['Decline: payment only in the app', 'Agree', 'Take half in cash'] }, answer: 0 },
  { id: 'banned', ru: 'Можно ли везти пропан, оружие или алкоголь?', en: 'May you carry propane, firearms or alcohol?', options: { ru: ['Нет, это запрещённые грузы', 'Да, если хорошо платят', 'Да, если упаковано'], en: ['No, these are prohibited', 'Yes, if the pay is good', 'Yes, if it is packed'] }, answer: 0 },
] as const;

export function quizFor(lang: string) {
  const l = lang === 'en' ? 'en' : 'ru';
  return QUIZ.map((q) => ({ id: q.id, question: q[l], options: q.options[l] }));
}

export async function submitAgreement(ctx: Ctx, userId: string, answers: Record<string, number>) {
  await getDriver(ctx.db, userId);
  const wrong = QUIZ.filter((q) => answers[q.id] !== q.answer).map((q) => q.id);
  if (wrong.length) throw bad('quiz_failed', 'Some answers are wrong', { wrong });
  await ctx.db.query('UPDATE drivers SET agreement_accepted_at = coalesce(agreement_accepted_at, now()), quiz_passed_at = now() WHERE user_id = $1', [userId]);
  return driverOverview(ctx, userId);
}

// ---------------------------------------------------------------- identity & payouts (Stripe)

export async function startIdentity(ctx: Ctx, userId: string) {
  const d = await getDriver(ctx.db, userId);
  if (d.identity_status === 'verified') throw conflict('already_verified', 'Identity is already verified');
  const s = await ctx.payments.createIdentitySession({ userId, returnUrl: `${ctx.cfg.publicUrl}/return/identity` });
  await ctx.db.query(`UPDATE drivers SET identity_status = 'pending', identity_session_id = $2 WHERE user_id = $1`, [userId, s.id]);
  return { url: s.url, clientSecret: s.clientSecret };
}

export async function startPayouts(ctx: Ctx, userId: string, email: string | null, phone: string) {
  const d = await getDriver(ctx.db, userId);
  let accountId = d.stripe_account_id;
  if (!accountId) {
    accountId = await ctx.payments.createConnectedAccount({ userId, email, phone });
    await ctx.db.query('UPDATE drivers SET stripe_account_id = $2 WHERE user_id = $1', [userId, accountId]);
  }
  const url = await ctx.payments.onboardingLink(accountId, `${ctx.cfg.publicUrl}/return/payouts`, `${ctx.cfg.publicUrl}/return/payouts?refresh=1`);
  return { url };
}

export async function refreshPayouts(ctx: Ctx, userId: string) {
  const d = await getDriver(ctx.db, userId);
  if (d.stripe_account_id) {
    const enabled = await ctx.payments.accountPayoutsEnabled(d.stripe_account_id);
    await ctx.db.query('UPDATE drivers SET payouts_enabled = $2 WHERE user_id = $1', [userId, enabled]);
    if (enabled) {
      const { retryHeldPayouts } = await import('./payouts.js');
      await retryHeldPayouts(ctx, userId);
    }
  }
  return driverOverview(ctx, userId);
}

// ---------------------------------------------------------------- checklist & submission

export interface Check {
  key: string;
  done: boolean;
  requiredToSubmit: boolean;
  requiredToApprove: boolean;
}

export function checklist(d: DriverRow, vehicles: VehicleRow[], docs: DocRow[], today: string): Check[] {
  const has = (kinds: DocKind[], needApproved = false) =>
    docs.some((x) => kinds.includes(x.kind) && x.status !== 'rejected' && (!needApproved || x.status === 'approved') && (!x.expires_on || x.expires_on >= today));
  const c = (key: string, done: boolean, requiredToSubmit = true, requiredToApprove = true): Check => ({ key, done, requiredToSubmit, requiredToApprove });
  return [
    c('profile', Boolean(d.legal_name && d.address && d.date_of_birth && d.home_city && d.home_lat !== null)),
    c('vehicle', vehicles.some((v) => v.active)),
    c('license', has(['license_front']) && has(['license_back'])),
    c('registration', has(['registration'])),
    c('delivery_insurance', has(DELIVERY_COVER)),
    c('identity', d.identity_status === 'verified' || d.identity_status === 'pending', true, false),
    c('identity_verified', d.identity_status === 'verified', false, true),
    c('background_check', has(['background_check']) || d.background_status !== 'none', true, false),
    c('background_clear', d.background_status === 'clear', false, true),
    c('agreement', Boolean(d.agreement_accepted_at && d.quiz_passed_at)),
    c('payouts', Boolean(d.stripe_account_id)),
    c('documents_approved', docs.filter((x) => x.status !== 'rejected').length > 0 && docs.every((x) => x.status !== 'pending'), false, true),
  ];
}

export async function driverOverview(ctx: Ctx, userId: string) {
  const d = await getDriver(ctx.db, userId);
  const vehicles = await ctx.db.query<VehicleRow>('SELECT * FROM vehicles WHERE driver_id = $1 AND active ORDER BY created_at', [userId]);
  const docs = await ctx.db.query<DocRow>('SELECT * FROM documents WHERE driver_id = $1 ORDER BY created_at DESC', [userId]);
  const today = ctx.now().toISOString().slice(0, 10);
  return {
    driver: driverSelfDto(d),
    vehicles: vehicles.map(vehicleDto),
    documents: docs.map((x) => docDto(x)),
    checklist: checklist(d, vehicles, docs, today),
  };
}

export async function submitForReview(ctx: Ctx, userId: string) {
  const o = await driverOverview(ctx, userId);
  if (o.driver.status === 'approved') throw conflict('already_approved');
  const missing = o.checklist.filter((c) => c.requiredToSubmit && !c.done).map((c) => c.key);
  if (missing.length) throw bad('incomplete', 'Some steps are not finished', { missing });
  await ctx.db.query(`UPDATE drivers SET status = 'pending', submitted_at = now() WHERE user_id = $1`, [userId]);
  await notifyAdmins(ctx, 'driver_submitted', { name: o.driver.legalName ?? '' });
  return driverOverview(ctx, userId);
}

export async function updateLocation(ctx: Ctx, userId: string, lat: number, lng: number) {
  await ctx.db.query('UPDATE drivers SET last_lat = $2, last_lng = $3, last_seen_at = now() WHERE user_id = $1', [userId, lat, lng]);
  const active = await ctx.db.query<{ id: string; client_id: string }>(
    `UPDATE orders SET driver_lat = $2, driver_lng = $3, driver_pos_at = now()
     WHERE driver_id = $1 AND status IN ('agreed','picked_up','in_transit') RETURNING id, client_id`,
    [userId, lat, lng],
  );
  for (const o of active) ctx.hub.publish(o.client_id, 'driver_position', { orderId: o.id, lat, lng, at: ctx.now().toISOString() });
}

// ---------------------------------------------------------------- admin review

export const reviewDocSchema = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(300).optional() });

export async function reviewDocument(ctx: Ctx, adminId: string, docId: string, p: z.infer<typeof reviewDocSchema>) {
  const doc = await maybeOne<DocRow>(ctx.db, 'UPDATE documents SET status = $2, note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *', [docId, p.status, p.note ?? null, adminId]);
  if (!doc) throw notFound('Document not found');
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'document_reviewed', $2, $3)`, [adminId, docId, p]);
  if (p.status === 'rejected') await notify(ctx, doc.driver_id, 'doc_rejected', { doc: doc.kind, reason: p.note ?? '' });
  return docDto(doc);
}

export const decisionSchema = z.object({
  status: z.enum(['approved', 'rejected', 'paused']),
  tier: z.enum(['basic', 'pro']).optional(),
  carHauler: z.boolean().optional(),
  cargoLimitCents: z.number().int().min(0).optional(),
  backgroundStatus: z.enum(['none', 'pending', 'clear', 'failed']).optional(),
  reason: z.string().max(300).optional(),
  force: z.boolean().optional(),
});

export async function decideDriver(ctx: Ctx, adminId: string, userId: string, p: z.infer<typeof decisionSchema>) {
  if (p.backgroundStatus) await ctx.db.query('UPDATE drivers SET background_status = $2 WHERE user_id = $1', [userId, p.backgroundStatus]);
  const o = await driverOverview(ctx, userId);
  if (p.status === 'approved' && !p.force) {
    const missing = o.checklist.filter((c) => c.requiredToApprove && !c.done).map((c) => c.key);
    if (missing.length) throw bad('not_ready', 'Not ready to approve', { missing });
  }
  const tier = p.tier ?? o.driver.tier;
  const cargoLimit = p.cargoLimitCents ?? (tier === 'pro' ? Math.max(o.driver.cargoLimitCents, maxCoverage(o.documents, 'insurance_cargo')) : ctx.cfg.rules.basicCargoLimitCents);
  await ctx.db.query(
    `UPDATE drivers SET status = $2::driver_status, tier = $3, car_hauler = coalesce($4, car_hauler), cargo_limit_cents = $5,
       approved_at = CASE WHEN $2::driver_status = 'approved' THEN coalesce(approved_at, now()) ELSE approved_at END,
       paused_reason = CASE WHEN $2::driver_status = 'paused' THEN $6 ELSE NULL END
     WHERE user_id = $1`,
    [userId, p.status, tier, p.carHauler ?? null, cargoLimit, p.reason ?? null],
  );
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'driver_decision', $2, $3)`, [adminId, userId, p]);
  if (p.status === 'approved') await notify(ctx, userId, o.driver.status === 'approved' && tier !== o.driver.tier ? 'tier_changed' : 'driver_approved', { tier: tier === 'pro' ? 'Pro' : 'Basic' });
  if (p.status === 'rejected') await notify(ctx, userId, 'driver_rejected', { reason: p.reason ?? '' });
  if (p.status === 'paused') await notify(ctx, userId, 'account_paused', { reason: p.reason ?? '' });
  return driverOverview(ctx, userId);
}

function maxCoverage(docs: ReturnType<typeof docDto>[], kind: DocKind): number {
  return Math.max(0, ...docs.filter((d) => d.kind === kind && d.status === 'approved').map((d) => d.coverageCents ?? 0));
}

export async function setBackgroundStatus(ctx: Ctx, adminId: string, userId: string, status: 'none' | 'pending' | 'clear' | 'failed') {
  const r = await ctx.db.query('UPDATE drivers SET background_status = $2 WHERE user_id = $1 RETURNING user_id', [userId, status]);
  if (!r.length) throw notFound('Driver not found');
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'background_status', $2, $3)`, [adminId, userId, { status }]);
  return adminDriverDetail(ctx, userId);
}

export async function adminListDrivers(ctx: Ctx, status?: string) {
  const rows = await ctx.db.query<DriverRow & { phone: string; name: string | null; rating_sum: number; rating_count: number }>(
    `SELECT d.*, u.phone, u.name, u.rating_sum, u.rating_count FROM drivers d JOIN users u ON u.id = d.user_id
     WHERE ($1::text IS NULL OR d.status::text = $1) ORDER BY coalesce(d.submitted_at, d.created_at) DESC LIMIT 200`,
    [status ?? null],
  );
  return rows.map((r) => ({ userId: r.user_id, phone: r.phone, name: r.name, ...driverSelfDto(r), rating: r.rating_count ? r.rating_sum / r.rating_count : null }));
}

export async function adminDriverDetail(ctx: Ctx, userId: string) {
  const o = await driverOverview(ctx, userId);
  const docs = await ctx.db.query<DocRow>('SELECT * FROM documents WHERE driver_id = $1 ORDER BY created_at DESC', [userId]);
  const u = await one<{ phone: string; name: string | null; email: string | null }>(ctx.db, 'SELECT phone, name, email FROM users WHERE id = $1', [userId]);
  return { ...o, user: u, documents: docs.map((d) => docDto(d, ctx.storage.url(d.file_key))) };
}

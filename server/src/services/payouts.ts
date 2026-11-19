// Paying drivers: transfer to their Stripe Connect account from the order's charge.
// A payout waits (and is retried later) when the driver has no tax number on file
// (CRA platform reporting) or has not finished Stripe payout setup.
import type { Ctx } from '../ctx.js';
import { maybeOne } from '../db/db.js';
import { fmtCad } from '../lib/pricing.js';
import type { DriverRow, OrderRow } from './dto.js';
import { notify } from './notify.js';

export type PayoutKind = 'delivery' | 'cancel_comp';

const REASONS: Record<string, { ru: string; en: string }> = {
  tax_info_missing: { ru: 'укажите SIN или BN в профиле', en: 'add your SIN or BN in your profile' },
  payouts_not_enabled: { ru: 'завершите настройку выплат Stripe', en: 'finish Stripe payout setup' },
  transfer_failed: { ru: 'ошибка перевода, поддержка в курсе', en: 'transfer error, support has been notified' },
};

export function payoutAmount(o: OrderRow, kind: PayoutKind): number {
  if (kind === 'delivery') return (o.agreed_cents ?? 0) - (o.driver_fee_cents ?? 0);
  return o.driver_comp_cents ?? 0;
}

export async function payDriver(ctx: Ctx, orderId: string, kind: PayoutKind): Promise<'paid' | 'held' | 'skipped'> {
  const o = await maybeOne<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o || !o.driver_id || o.paid_out_at) return 'skipped';
  const amount = payoutAmount(o, kind);
  if (amount <= 0 || !o.charge_id) return 'skipped';
  const d = await maybeOne<DriverRow>(ctx.db, 'SELECT * FROM drivers WHERE user_id = $1', [o.driver_id]);
  if (!d) return 'skipped';
  const hold = !d.tax_id_enc ? 'tax_info_missing' : !d.payouts_enabled || !d.stripe_account_id ? 'payouts_not_enabled' : null;
  const [lang] = await ctx.db.query<{ lang: string }>('SELECT lang FROM users WHERE id = $1', [o.driver_id]);
  const l = lang?.lang === 'en' ? 'en' : 'ru';
  if (hold) {
    if (o.payout_held_reason !== hold) {
      await ctx.db.query('UPDATE orders SET payout_held_reason = $2 WHERE id = $1', [orderId, hold]);
      await notify(ctx, o.driver_id, hold === 'tax_info_missing' ? 'tax_info_needed' : 'payout_held', { number: o.number, reason: REASONS[hold]![l] }, { orderId });
    }
    return 'held';
  }
  try {
    const t = await ctx.payments.transfer({ accountId: d.stripe_account_id!, amountCents: amount, chargeId: o.charge_id, orderId, idempotencyKey: `payout-${orderId}-${kind}` });
    await ctx.db.query('UPDATE orders SET transfer_id = $2, paid_out_at = now(), payout_held_reason = NULL WHERE id = $1', [orderId, t.transferId]);
    await ctx.db.query('INSERT INTO order_events(order_id, type, data) VALUES ($1, $2, $3)', [orderId, 'paid_out', { kind, amountCents: amount, transferId: t.transferId }]);
    await notify(ctx, o.driver_id, 'payout_sent', { number: o.number, amount: fmtCad(amount) }, { orderId });
    return 'paid';
  } catch (e) {
    ctx.log(`payout failed for order ${orderId}`, e);
    await ctx.db.query(`UPDATE orders SET payout_held_reason = 'transfer_failed' WHERE id = $1`, [orderId]);
    return 'held';
  }
}

/** Pay out everything that was waiting for this driver. */
export async function retryHeldPayouts(ctx: Ctx, driverId: string): Promise<number> {
  const rows = await ctx.db.query<{ id: string; status: string }>(
    `SELECT id, status FROM orders WHERE driver_id = $1 AND paid_out_at IS NULL AND payout_held_reason IS NOT NULL AND status IN ('delivered','cancelled')`,
    [driverId],
  );
  let paid = 0;
  for (const r of rows) if ((await payDriver(ctx, r.id, r.status === 'delivered' ? 'delivery' : 'cancel_comp')) === 'paid') paid++;
  return paid;
}

export async function driverEarnings(ctx: Ctx, driverId: string) {
  const rows = await ctx.db.query<{ status: string; agreed_cents: number | null; driver_fee_cents: number | null; driver_comp_cents: number | null; paid_out_at: string | null; payout_held_reason: string | null; delivered_at: string | null; cancelled_at: string | null }>(
    `SELECT status, agreed_cents, driver_fee_cents, driver_comp_cents, paid_out_at, payout_held_reason, delivered_at, cancelled_at
     FROM orders WHERE driver_id = $1 AND status IN ('delivered','cancelled') AND coalesce(delivered_at, cancelled_at) > date_trunc('year', now())`,
    [driverId],
  );
  const now = ctx.now();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  let today = 0, week = 0, year = 0, held = 0, fees = 0;
  for (const r of rows) {
    const net = r.status === 'delivered' ? (r.agreed_cents ?? 0) - (r.driver_fee_cents ?? 0) : r.driver_comp_cents ?? 0;
    const at = new Date((r.delivered_at ?? r.cancelled_at)!);
    year += net;
    if (r.status === 'delivered') fees += r.driver_fee_cents ?? 0;
    if (at >= weekAgo) week += net;
    if (at >= startOfDay) today += net;
    if (!r.paid_out_at && r.payout_held_reason) held += net;
  }
  return { todayCents: today, weekCents: week, yearCents: year, heldCents: held, feesYearCents: fees, jobsYear: rows.filter((r) => r.status === 'delivered').length };
}

// Chat, ratings and disputes.
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { isPgCode, maybeOne, one, PgCode } from '../db/db.js';
import { filterContacts } from '../lib/contactFilter.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import { fmtCad } from '../lib/pricing.js';
import type { OrderRow } from './dto.js';
import { notify, notifyAdmins } from './notify.js';
import { applyCancel } from './orders.js';

async function participantOrder(ctx: Ctx, userId: string, orderId: string, isAdmin = false): Promise<{ o: OrderRow; role: 'client' | 'driver' | 'admin' }> {
  const o = await maybeOne<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o) throw notFound('Order not found');
  if (o.client_id === userId) return { o, role: 'client' };
  if (o.driver_id === userId) return { o, role: 'driver' };
  if (isAdmin) return { o, role: 'admin' };
  throw notFound('Order not found');
}

// ---------------------------------------------------------------- chat

export async function listMessages(ctx: Ctx, userId: string, orderId: string, isAdmin = false) {
  await participantOrder(ctx, userId, orderId, isAdmin);
  const rows = await ctx.db.query<{ id: number; sender_id: string | null; body: string; had_contact: boolean; created_at: string }>(
    'SELECT id, sender_id, body, had_contact, created_at FROM messages WHERE order_id = $1 ORDER BY id LIMIT 500',
    [orderId],
  );
  return rows.map((m) => ({ id: m.id, from: m.sender_id === null ? 'system' : m.sender_id === userId ? 'me' : 'them', body: m.body, contactHidden: m.had_contact, createdAt: m.created_at }));
}

export async function sendMessage(ctx: Ctx, userId: string, orderId: string, body: string) {
  const { o, role } = await participantOrder(ctx, userId, orderId);
  if (!o.driver_id) throw conflict('no_driver', 'Chat opens once a driver confirms the order');
  const closedAt = o.delivered_at ?? o.cancelled_at;
  if (closedAt && ctx.now().getTime() - new Date(closedAt).getTime() > 48 * 3_600_000) throw conflict('chat_closed', 'Chat is closed for this order');
  const text = body.trim();
  if (!text) throw bad('empty_message');
  if (text.length > 1000) throw bad('message_too_long', 'Messages can be up to 1000 characters');
  const f = filterContacts(text);
  const m = await one<{ id: number; created_at: string }>(ctx.db, 'INSERT INTO messages(order_id, sender_id, body, had_contact) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [orderId, userId, f.text, f.hidden]);
  const other = role === 'client' ? o.driver_id : o.client_id;
  ctx.hub.publish(userId, 'message', { id: m.id, orderId, from: 'me', body: f.text, contactHidden: f.hidden, createdAt: m.created_at });
  ctx.hub.publish(other, 'message', { id: m.id, orderId, from: 'them', body: f.text, contactHidden: f.hidden, createdAt: m.created_at });
  await notify(ctx, other, 'chat_message', { number: o.number, text: f.text.slice(0, 120) }, { orderId });
  return { id: m.id, from: 'me', body: f.text, contactHidden: f.hidden, createdAt: m.created_at };
}

// ---------------------------------------------------------------- ratings

export const rateSchema = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() });

export async function rate(ctx: Ctx, userId: string, orderId: string, p: z.infer<typeof rateSchema>) {
  const { o, role } = await participantOrder(ctx, userId, orderId);
  if (o.status !== 'delivered') throw conflict('not_delivered', 'You can rate after delivery');
  const to = role === 'client' ? o.driver_id! : o.client_id;
  try {
    await ctx.db.tx(async (q) => {
      await q.query('INSERT INTO ratings(order_id, from_user_id, to_user_id, stars, comment) VALUES ($1, $2, $3, $4, $5)', [orderId, userId, to, p.stars, p.comment ?? null]);
      await q.query('UPDATE users SET rating_sum = rating_sum + $2, rating_count = rating_count + 1 WHERE id = $1', [to, p.stars]);
    });
  } catch (e) {
    if (isPgCode(e, PgCode.uniqueViolation)) throw conflict('already_rated', 'You have already rated this order');
    throw e;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- disputes

export const disputeSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

export async function openDispute(ctx: Ctx, userId: string, orderId: string, p: z.infer<typeof disputeSchema>) {
  const { o, role } = await participantOrder(ctx, userId, orderId);
  if (o.status === 'open') throw conflict('no_driver', 'Disputes are for confirmed orders');
  const closedAt = o.delivered_at ?? o.cancelled_at;
  if (closedAt && ctx.now().getTime() - new Date(closedAt).getTime() > 7 * 86_400_000) throw conflict('too_late', 'Disputes can be opened up to 7 days after the order closed');
  const [existing] = await ctx.db.query<{ id: string }>(`SELECT id FROM disputes WHERE order_id = $1 AND status = 'open'`, [orderId]);
  if (existing) throw conflict('dispute_open', 'A dispute for this order is already open');
  const d = await one<{ id: string }>(ctx.db, 'INSERT INTO disputes(order_id, opened_by, reason) VALUES ($1, $2, $3) RETURNING id', [orderId, userId, p.reason]);
  await ctx.db.query('INSERT INTO order_events(order_id, actor_id, type, data) VALUES ($1, $2, $3, $4)', [orderId, userId, 'dispute_opened', { disputeId: d.id, role }]);
  const other = role === 'client' ? o.driver_id : o.client_id;
  if (other) await notify(ctx, other, 'dispute_opened', { number: o.number, reason: p.reason.slice(0, 100) }, { orderId });
  await notifyAdmins(ctx, 'dispute_opened', { number: o.number, reason: p.reason.slice(0, 100) }, orderId);
  return { id: d.id };
}

export const resolveSchema = z.object({
  resolution: z.string().trim().min(3).max(1000),
  action: z.enum(['none', 'refund', 'no_show']).default('none'),
  refundCents: z.number().int().min(1).optional(),
});

export async function resolveDispute(ctx: Ctx, adminId: string, disputeId: string, p: z.infer<typeof resolveSchema>) {
  const d = await maybeOne<{ id: string; order_id: string; status: string }>(ctx.db, 'SELECT id, order_id, status FROM disputes WHERE id = $1', [disputeId]);
  if (!d) throw notFound('Dispute not found');
  if (d.status !== 'open') throw conflict('already_resolved');
  const o = await one<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [d.order_id]);
  if (p.action === 'refund') {
    if (!p.refundCents) throw bad('refund_amount_required');
    if (!o.payment_intent_id) throw conflict('not_charged', 'This order was never charged');
    const [{ refunded } = { refunded: 0 }] = await ctx.db.query<{ refunded: number }>(
      `SELECT coalesce(sum((data->>'amountCents')::int), 0)::int AS refunded FROM order_events WHERE order_id = $1 AND type = 'admin_refund'`,
      [o.id],
    );
    const refundable = (o.charged_cents ?? 0) - (o.refund_cents ?? 0) - refunded;
    if (p.refundCents > refundable) throw bad('refund_too_large', `At most ${fmtCad(refundable)} can be refunded`);
    await ctx.payments.refund({ paymentIntentId: o.payment_intent_id, amountCents: p.refundCents, idempotencyKey: `refund-dispute-${d.id}` });
    await ctx.db.query('INSERT INTO order_events(order_id, actor_id, type, data) VALUES ($1, $2, $3, $4)', [o.id, adminId, 'admin_refund', { amountCents: p.refundCents, disputeId: d.id }]);
  }
  if (p.action === 'no_show') {
    if (o.status !== 'agreed') throw conflict('bad_status', 'No-show applies to confirmed orders that were not picked up');
    await applyCancel(ctx, o.id, 'admin', adminId, 'no_show', true);
  }
  await ctx.db.query(`UPDATE disputes SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [d.id, p.resolution, adminId]);
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'dispute_resolved', $2, $3)`, [adminId, d.id, p]);
  for (const u of [o.client_id, o.driver_id]) if (u) await notify(ctx, u, 'dispute_resolved', { number: o.number, resolution: p.resolution.slice(0, 120) }, { orderId: o.id });
  return { ok: true };
}

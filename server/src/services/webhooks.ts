// Stripe webhook events.
import type { Ctx } from '../ctx.js';
import type { StripeEvent } from '../providers/payments.js';
import { notifyAdmins } from './notify.js';
import { retryHeldPayouts } from './payouts.js';

export async function handleStripeEvent(ctx: Ctx, ev: StripeEvent): Promise<'handled' | 'duplicate' | 'ignored'> {
  const fresh = await ctx.db.query('INSERT INTO processed_events(id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [ev.id]);
  if (!fresh.length) return 'duplicate';
  const obj = ev.data.object;
  switch (ev.type) {
    case 'account.updated': {
      const rows = await ctx.db.query<{ user_id: string }>('UPDATE drivers SET payouts_enabled = $2 WHERE stripe_account_id = $1 RETURNING user_id', [obj.id, Boolean(obj.payouts_enabled)]);
      for (const r of rows) if (obj.payouts_enabled) await retryHeldPayouts(ctx, r.user_id);
      return 'handled';
    }
    case 'identity.verification_session.verified':
    case 'identity.verification_session.requires_input':
    case 'identity.verification_session.canceled': {
      const status = ev.type.endsWith('verified') ? 'verified' : 'failed';
      await ctx.db.query('UPDATE drivers SET identity_status = $2 WHERE identity_session_id = $1 OR user_id::text = $3', [obj.id, status, obj.metadata?.user_id ?? '']);
      return 'handled';
    }
    case 'setup_intent.succeeded': {
      if (!obj.customer || !obj.payment_method) return 'ignored';
      const card = await ctx.payments.latestCard(obj.customer);
      if (card) await ctx.db.query('UPDATE users SET payment_method_id = $2, card_brand = $3, card_last4 = $4 WHERE stripe_customer_id = $1', [obj.customer, card.paymentMethodId, card.brand, card.last4]);
      return 'handled';
    }
    case 'charge.dispute.created': {
      const [o] = await ctx.db.query<{ id: string; number: number; client_id: string }>('SELECT id, number, client_id FROM orders WHERE payment_intent_id = $1', [obj.payment_intent]);
      if (!o) return 'ignored';
      await ctx.db.query('INSERT INTO disputes(order_id, opened_by, reason) VALUES ($1, $2, $3)', [o.id, o.client_id, `Card chargeback: ${obj.reason ?? 'unknown'}`]);
      await ctx.db.query(`INSERT INTO order_events(order_id, type, data) VALUES ($1, 'chargeback', $2)`, [o.id, { disputeId: obj.id, amount: obj.amount, reason: obj.reason }]);
      await notifyAdmins(ctx, 'dispute_opened', { number: o.number, reason: 'chargeback' }, o.id);
      return 'handled';
    }
    default:
      return 'ignored';
  }
}

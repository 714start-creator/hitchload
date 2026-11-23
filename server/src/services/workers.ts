// Background jobs, run in-process on a timer.
import { ENDORSEMENT_LIMIT_CENTS } from './drivers.js';
import type { Ctx } from '../ctx.js';
import { dispatchOrder } from './dispatch.js';
import type { OrderRow } from './dto.js';
import { notify } from './notify.js';

/** After the Pro-only window, tell everyone else about the order. */
export async function broadcastAfterProWindow(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<OrderRow>(
    `UPDATE orders SET broadcast_at = now()
     WHERE status = 'open' AND broadcast_at IS NULL AND pro_until <= $1::timestamptz AND requested_driver_id IS NULL
     RETURNING *`,
    [ctx.now().toISOString()],
  );
  for (const o of rows) await dispatchOrder(ctx, o, 'basic');
  return rows.length;
}

/** A driver did not confirm a booking on their trip in time: open the order to everyone. */
export async function expireTripRequests(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<OrderRow>(
    `UPDATE orders SET requested_driver_id = NULL, request_expires_at = NULL, pro_until = $1::timestamptz, broadcast_at = $1::timestamptz, updated_at = now()
     WHERE status = 'open' AND requested_driver_id IS NOT NULL AND request_expires_at <= $1::timestamptz
     RETURNING *`,
    [ctx.now().toISOString()],
  );
  for (const o of rows) {
    await ctx.db.query(`INSERT INTO order_events(order_id, type) VALUES ($1, 'request_expired')`, [o.id]);
    await notify(ctx, o.client_id, 'trip_request_expired', { number: o.number }, { orderId: o.id });
    await dispatchOrder(ctx, o, 'all');
  }
  return rows.length;
}

/** Nobody took the order before its loading window ended. Nothing was charged. */
export async function expireOpenOrders(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query<OrderRow>(
    `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'window_passed', updated_at = now()
     WHERE status = 'open' AND window_end <= $1::timestamptz RETURNING *`,
    [ctx.now().toISOString()],
  );
  for (const o of rows) {
    await ctx.db.query(`UPDATE offers SET status = 'expired' WHERE order_id = $1 AND status = 'pending'`, [o.id]);
    await notify(ctx, o.client_id, 'order_expired', { number: o.number }, { orderId: o.id });
  }
  return rows.length;
}

const DOC_LABEL: Record<string, string> = {
  insurance_auto: 'Auto policy', insurance_endorsement: 'Delivery endorsement', insurance_commercial: 'Commercial auto policy',
  insurance_cargo: 'Cargo policy', insurance_car_hauling: 'Car hauling policy',
};

/** Reminders 30 and 7 days before a policy ends; pause or downgrade when it has ended. */
export async function insuranceCheck(ctx: Ctx): Promise<{ reminded: number; paused: number; downgraded: number }> {
  const today = ctx.now().toISOString().slice(0, 10);
  let reminded = 0, paused = 0, downgraded = 0;
  for (const [days, col, type] of [[30, 'reminded_30_at', 'doc_expiring_30'], [7, 'reminded_7_at', 'doc_expiring_7']] as const) {
    const due = await ctx.db.query<{ id: string; driver_id: string; kind: string; expires_on: string }>(
      `UPDATE documents SET ${col} = now()
       WHERE status = 'approved' AND kind::text LIKE 'insurance%' AND ${col} IS NULL AND expires_on >= $1::date AND expires_on <= $1::date + $2::int
         AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.driver_id = documents.driver_id AND n.kind = documents.kind AND n.status <> 'rejected' AND n.expires_on > documents.expires_on)
       RETURNING id, driver_id, kind, expires_on`,
      [today, days],
    );
    for (const d of due) {
      await notify(ctx, d.driver_id, type, { doc: DOC_LABEL[d.kind] ?? d.kind, date: d.expires_on });
      reminded++;
    }
  }
  // no valid delivery cover any more -> pause
  const lapsed = await ctx.db.query<{ user_id: string }>(
    `UPDATE drivers SET status = 'paused', paused_reason = 'insurance_expired'
     WHERE status = 'approved' AND NOT EXISTS (
       SELECT 1 FROM documents x WHERE x.driver_id = drivers.user_id
         AND (x.kind IN ('insurance_endorsement','insurance_commercial') OR (x.kind = 'insurance_auto' AND x.risk_ack_at IS NOT NULL))
         AND x.status = 'approved' AND x.expires_on >= $1::date)
     RETURNING user_id`,
    [today],
  );
  for (const d of lapsed) {
    await notify(ctx, d.user_id, 'insurance_lapsed');
    paused++;
  }
  // Pro without a valid cargo policy -> Basic
  const down = await ctx.db.query<{ user_id: string }>(
    `UPDATE drivers SET tier = 'basic', cargo_limit_cents = $2
     WHERE tier = 'pro' AND NOT EXISTS (
       SELECT 1 FROM documents x WHERE x.driver_id = drivers.user_id AND x.kind = 'insurance_cargo' AND x.status = 'approved' AND x.expires_on >= $1::date)
     RETURNING user_id`,
    [today, ENDORSEMENT_LIMIT_CENTS], // they keep a commercial auto policy
  );
  for (const d of down) {
    await notify(ctx, d.user_id, 'tier_changed', { tier: 'Basic' });
    downgraded++;
  }
  return { reminded, paused, downgraded };
}

export function startWorkers(ctx: Ctx): () => void {
  let busy = false;
  const fast = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await broadcastAfterProWindow(ctx);
      await expireTripRequests(ctx);
      await expireOpenOrders(ctx);
    } catch (e) {
      ctx.log('worker error', e);
    } finally {
      busy = false;
    }
  }, 10_000);
  const hourly = setInterval(() => insuranceCheck(ctx).catch((e) => ctx.log('insurance check failed', e)), 3_600_000);
  insuranceCheck(ctx).catch((e) => ctx.log('insurance check failed', e));
  return () => {
    clearInterval(fast);
    clearInterval(hourly);
  };
}

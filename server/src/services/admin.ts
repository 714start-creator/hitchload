// Admin views and the yearly CRA platform-operator report.
import type { Ctx } from '../ctx.js';
import { maybeOne } from '../db/db.js';
import { notFound } from '../lib/errors.js';
import { revealTaxId } from './drivers.js';
import { orderDto, type DriverRow, type OfferRow, type OrderRow } from './dto.js';

export async function adminStats(ctx: Ctx) {
  const [s] = await ctx.db.query<Record<string, number>>(`
    SELECT
      (SELECT count(*)::int FROM orders WHERE created_at > now() - interval '1 day') AS orders_24h,
      (SELECT count(*)::int FROM orders WHERE status = 'open') AS open_orders,
      (SELECT count(*)::int FROM orders WHERE status IN ('agreed','picked_up','in_transit')) AS active_orders,
      (SELECT count(*)::int FROM orders WHERE status = 'delivered' AND delivered_at > now() - interval '30 days') AS delivered_30d,
      (SELECT coalesce(sum(client_fee_cents + driver_fee_cents), 0)::int FROM orders WHERE status = 'delivered' AND delivered_at > now() - interval '30 days') AS fees_30d_cents,
      (SELECT coalesce(sum(platform_comp_cents + coalesce(client_fee_cents, 0)), 0)::int FROM orders WHERE status = 'cancelled' AND cancelled_at > now() - interval '30 days' AND charged_cents IS NOT NULL) AS cancel_income_30d_cents,
      (SELECT coalesce(sum(insurance_cents), 0)::int FROM orders WHERE status IN ('agreed','picked_up','in_transit','delivered') AND charged_at > now() - interval '30 days') AS insurance_30d_cents,
      (SELECT count(*)::int FROM drivers WHERE status = 'pending') AS drivers_pending,
      (SELECT count(*)::int FROM drivers WHERE status = 'approved') AS drivers_approved,
      (SELECT count(*)::int FROM disputes WHERE status = 'open') AS disputes_open,
      (SELECT count(*)::int FROM orders WHERE payout_held_reason IS NOT NULL AND paid_out_at IS NULL) AS payouts_held`);
  return s;
}

export async function adminOrders(ctx: Ctx, status?: string, search?: string) {
  const rows = await ctx.db.query<OrderRow & { client_phone: string; driver_phone: string | null }>(
    `SELECT o.*, c.phone AS client_phone, dr.phone AS driver_phone FROM orders o JOIN users c ON c.id = o.client_id LEFT JOIN users dr ON dr.id = o.driver_id
     WHERE ($1::text IS NULL OR o.status::text = $1) AND ($2::text IS NULL OR o.number::text = $2 OR c.phone LIKE '%' || $2 || '%' OR dr.phone LIKE '%' || $2 || '%')
     ORDER BY o.created_at DESC LIMIT 200`,
    [status ?? null, search ?? null],
  );
  return rows.map((o) => ({ ...orderDto(o, 'admin'), clientPhone: o.client_phone, driverPhone: o.driver_phone }));
}

export async function adminOrder(ctx: Ctx, orderId: string) {
  const o = await maybeOne<OrderRow>(ctx.db, 'SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o) throw notFound('Order not found');
  const offers = await ctx.db.query<OfferRow>('SELECT * FROM offers WHERE order_id = $1 ORDER BY created_at', [orderId]);
  const events = await ctx.db.query<{ id: number; type: string; actor_id: string | null; data: unknown; created_at: string }>('SELECT * FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]);
  const photos = await ctx.db.query<{ stage: string; file_key: string; lat: number | null; lng: number | null; created_at: string }>('SELECT * FROM order_photos WHERE order_id = $1 ORDER BY created_at', [orderId]);
  const messages = await ctx.db.query<{ id: number; sender_id: string | null; body: string; had_contact: boolean; created_at: string }>('SELECT * FROM messages WHERE order_id = $1 ORDER BY id', [orderId]);
  const disputes = await ctx.db.query('SELECT * FROM disputes WHERE order_id = $1 ORDER BY created_at', [orderId]);
  return {
    order: orderDto(o, 'admin', { offers, urls: (k) => ctx.storage.url(k) }),
    events: events.map((e) => ({ id: e.id, type: e.type, actorId: e.actor_id, data: e.data, createdAt: e.created_at })),
    photos: photos.map((p) => ({ stage: p.stage, url: ctx.storage.url(p.file_key), lat: p.lat, lng: p.lng, createdAt: p.created_at })),
    messages: messages.map((m) => ({ id: m.id, senderId: m.sender_id, body: m.body, contactHidden: m.had_contact, createdAt: m.created_at })),
    disputes,
  };
}

export async function adminDisputes(ctx: Ctx, status: 'open' | 'resolved' = 'open') {
  return ctx.db.query(
    `SELECT d.*, o.number, o.status AS order_status, u.phone AS opened_by_phone FROM disputes d JOIN orders o ON o.id = d.order_id JOIN users u ON u.id = d.opened_by
     WHERE d.status = $1 ORDER BY d.created_at DESC LIMIT 200`,
    [status],
  );
}

export async function setUserBlocked(ctx: Ctx, adminId: string, userId: string, blocked: boolean) {
  await ctx.db.query('UPDATE users SET blocked = $2 WHERE id = $1', [userId, blocked]);
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'user_blocked', $2, $3)`, [adminId, userId, { blocked }]);
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Data for the CRA "Reporting Rules for Digital Platform Operators" (Part XX) return:
 * per driver and calendar quarter, money paid for services, fees the platform kept,
 * and the number of jobs. The XML filing itself is prepared by the accountant from this.
 */
export async function craReport(ctx: Ctx, adminId: string, year: number): Promise<string> {
  const rows = await ctx.db.query<{
    driver_id: string; quarter: number; consideration: number; fees: number; jobs: number;
  }>(
    `SELECT driver_id, extract(quarter FROM coalesce(delivered_at, cancelled_at))::int AS quarter,
            sum(CASE WHEN status = 'delivered' THEN agreed_cents ELSE coalesce(driver_comp_cents, 0) END)::int AS consideration,
            sum(CASE WHEN status = 'delivered' THEN coalesce(driver_fee_cents, 0) ELSE 0 END)::int AS fees,
            count(*)::int AS jobs
     FROM orders
     WHERE driver_id IS NOT NULL AND (status = 'delivered' OR (status = 'cancelled' AND coalesce(driver_comp_cents, 0) > 0))
       AND extract(year FROM coalesce(delivered_at, cancelled_at)) = $1
     GROUP BY driver_id, quarter`,
    [year],
  );
  const drivers = await ctx.db.query<DriverRow & { phone: string }>(
    `SELECT d.*, u.phone FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = ANY($1::uuid[])`,
    [[...new Set(rows.map((r) => r.driver_id))]],
  );
  const header = ['driver_id', 'legal_name', 'address', 'date_of_birth', 'tin_type', 'tin', 'gst_number', 'stripe_account', 'phone',
    ...[1, 2, 3, 4].flatMap((q) => [`q${q}_consideration_cad`, `q${q}_fees_cad`, `q${q}_jobs`]), 'missing_tin'];
  const lines = [header.join(',')];
  for (const d of drivers) {
    const byQ = (q: number) => rows.find((r) => r.driver_id === d.user_id && r.quarter === q);
    const tin = revealTaxId(ctx, d);
    lines.push([
      d.user_id, d.legal_name, d.address, d.date_of_birth, d.tax_id_type, tin, d.gst_number, d.stripe_account_id, d.phone,
      ...[1, 2, 3, 4].flatMap((q) => { const r = byQ(q); return [((r?.consideration ?? 0) / 100).toFixed(2), ((r?.fees ?? 0) / 100).toFixed(2), r?.jobs ?? 0]; }),
      tin ? 'no' : 'yes',
    ].map(csv).join(','));
  }
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, data) VALUES ($1, 'cra_report_exported', $2)`, [adminId, { year, drivers: drivers.length }]);
  return lines.join('\n') + '\n';
}

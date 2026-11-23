// Admin views and the yearly CRA platform-operator report.
import type { Ctx } from '../ctx.js';
import { maybeOne, type Queryable } from '../db/db.js';
import { bad, conflict, notFound } from '../lib/errors.js';
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

/** Users for the admin list: search by name, phone or email. Deleted users are left out. */
export async function adminUsers(ctx: Ctx, search?: string) {
  const q = search?.trim() ? `%${search.trim().toLowerCase()}%` : null;
  const digits = search?.replace(/\D/g, '') ?? '';
  return ctx.db.query<{ id: string; phone: string; name: string | null; email: string | null; is_admin: boolean; blocked: boolean; created_at: string; driver_status: string | null; driver_tier: string | null; orders: number; jobs: number }>(
    `SELECT u.id, u.phone, u.name, u.email, u.is_admin, u.blocked, u.created_at, d.status::text AS driver_status, d.tier::text AS driver_tier,
            (SELECT count(*)::int FROM orders o WHERE o.client_id = u.id) AS orders,
            (SELECT count(*)::int FROM orders o WHERE o.driver_id = u.id) AS jobs
       FROM users u LEFT JOIN drivers d ON d.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND ($1::text IS NULL OR lower(coalesce(u.name, '')) LIKE $1 OR lower(coalesce(u.email, '')) LIKE $1 OR ($2::text <> '' AND u.phone LIKE '%' || $2 || '%'))
      ORDER BY u.created_at DESC LIMIT 300`,
    [q, digits],
  );
}

/**
 * Delete a user. Someone with no paid or taken orders is removed completely (their open orders, trips,
 * documents and files go too). Someone with money history is anonymised: name, phone, email and card are wiped,
 * the account can no longer sign in, and the phone number is free to register again. Orders, payouts and the
 * driver's tax details stay, because accounting and the CRA report need them.
 */
export async function deleteUser(ctx: Ctx, adminId: string, userId: string): Promise<{ mode: 'deleted' | 'anonymised' }> {
  if (userId === adminId) throw bad('cannot_delete_self', 'You cannot delete your own account');
  const u = await maybeOne<{ id: string; phone: string; is_admin: boolean; deleted_at: string | null }>(ctx.db, 'SELECT id, phone, is_admin, deleted_at FROM users WHERE id = $1', [userId]);
  if (!u || u.deleted_at) throw notFound('User not found');
  if (u.is_admin) throw bad('cannot_delete_admin', 'This is an admin account. Remove the phone from ADMIN_PHONES first');
  const active = await ctx.db.query<{ number: number }>(
    `SELECT number FROM orders WHERE (client_id = $1 OR driver_id = $1) AND status IN ('agreed', 'picked_up', 'in_transit') ORDER BY number`,
    [userId],
  );
  if (active.length) throw conflict('active_orders', `This user has orders in progress (${active.map((o) => '#' + o.number).join(', ')}). Finish or cancel them first`);
  // money history: anything a driver took or a card was charged for
  const history = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM orders WHERE driver_id = $1 OR (client_id = $1 AND (driver_id IS NOT NULL OR charged_cents IS NOT NULL))`,
    [userId],
  );
  const files = (await ctx.db.query<{ file_key: string }>('SELECT file_key FROM documents WHERE driver_id = $1', [userId])).map((f) => f.file_key);
  const common = async (q: Queryable) => {
    await q.query(`UPDATE orders SET requested_driver_id = NULL WHERE requested_driver_id = $1`, [userId]);
    await q.query(`DELETE FROM offers WHERE driver_id = $1 AND status = 'pending'`, [userId]);
    await q.query(`UPDATE trips SET status = 'cancelled' WHERE driver_id = $1 AND status = 'active'`, [userId]);
  };
  let mode: 'deleted' | 'anonymised' = 'anonymised';
  if (!history[0]?.n) {
    try {
      await ctx.db.tx(async (q) => {
        await common(q);
        await q.query('DELETE FROM orders WHERE client_id = $1', [userId]); // only open or cancelled-before-a-driver orders are left
        await q.query('DELETE FROM offers WHERE driver_id = $1', [userId]);
        await q.query('UPDATE order_events SET actor_id = NULL WHERE actor_id = $1', [userId]);
        await q.query('UPDATE messages SET sender_id = NULL WHERE sender_id = $1', [userId]);
        await q.query('UPDATE audit_log SET actor_id = NULL WHERE actor_id = $1', [userId]);
        await q.query('UPDATE trips SET vehicle_id = NULL WHERE driver_id = $1', [userId]);
        await q.query('DELETE FROM otp_codes WHERE phone = $1', [u.phone]);
        await q.query('DELETE FROM users WHERE id = $1', [userId]);
      });
      mode = 'deleted';
    } catch (e) {
      ctx.log('user delete fell back to anonymising', { userId, err: String(e) });
    }
  }
  if (mode === 'anonymised') {
    await ctx.db.tx(async (q) => {
      await common(q);
      await q.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Account deleted' WHERE client_id = $1 AND status = 'open'`,
        [userId],
      );
      await q.query(
        `UPDATE users SET phone = 'deleted:' || id::text, name = 'Deleted user', email = NULL, email_verified_at = NULL, email_token_hash = NULL,
           email_alerts = false, stripe_customer_id = NULL, payment_method_id = NULL, card_brand = NULL, card_last4 = NULL,
           blocked = true, deleted_at = now()
         WHERE id = $1`,
        [userId],
      );
      await q.query(`UPDATE drivers SET status = 'rejected', paused_reason = 'Account deleted', address = NULL WHERE user_id = $1`, [userId]);
      await q.query('DELETE FROM documents WHERE driver_id = $1', [userId]);
      await q.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM route_alerts WHERE user_id = $1', [userId]);
      await q.query('DELETE FROM otp_codes WHERE phone = $1', [u.phone]);
    });
  }
  if (ctx.storage.kind === 'db' && files.length) await ctx.db.query('DELETE FROM stored_files WHERE key = ANY($1::text[])', [files]).catch(() => undefined);
  await ctx.db.query(`INSERT INTO audit_log(actor_id, action, target, data) VALUES ($1, 'user_deleted', $2, $3)`, [adminId, userId, { mode }]);
  return { mode };
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

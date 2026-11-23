// Admin deletes users.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { customer, expectError, onboardDriver, places, signIn, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;
let mike: Awaited<ReturnType<typeof onboardDriver>>;
const hours = (h: number) => new Date(app.ctx.now().getTime() + h * 3_600_000).toISOString();

before(async () => {
  app = await startTestApp('del');
  mike = await onboardDriver(app, '7805550960', { name: 'Mike Pro', tier: 'pro' });
});
after(async () => {
  await app?.close();
});

test('admin deletes users: no history → removed; paid orders → anonymised; active order, admin or self → refused', async () => {
  const admin = await signIn(app, '+17800000001');
  const find = async (q: string) => (await admin.api.get(`/v1/admin/users?q=${encodeURIComponent(q)}`)) as { id: string; phone: string; name: string }[];

  // 1) a customer who only posted an open order: removed completely, the phone can sign up again
  const dina = await customer(app, '7805550961', 'Dina Delete');
  const open = await dina.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.kensington, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(2), windowEnd: hours(6), priceCents: 4000 });
  const [d] = await find('Dina');
  assert.ok(d);
  assert.deepEqual(await admin.api.del(`/v1/admin/users/${d.id}`), { mode: 'deleted' });
  assert.equal((await find('Dina')).length, 0);
  assert.equal((await app.ctx.db.query('SELECT 1 FROM orders WHERE id = $1', [open.id])).length, 0, 'the open order is gone');
  await expectError(dina.api.get('/v1/me'), 401);
  assert.equal((await app.ctx.db.query(`SELECT 1 FROM users WHERE phone = '+17805550961'`)).length, 0, 'the phone can sign up again');

  // 2) a customer whose order a driver took: refused while it is in progress
  const ed = await customer(app, '7805550962', 'Ed Paid');
  const o = await ed.api.post('/v1/orders', { pickup: places.whyteAve, dropoff: places.kensington, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(3), windowEnd: hours(6), priceCents: 5000 });
  await mike.api.post(`/v1/driver/orders/${o.id}/take`);
  const [e] = await find('Ed Paid');
  const busy = await expectError(admin.api.del(`/v1/admin/users/${e!.id}`), 409, 'active_orders');
  assert.match(busy.error.message, /#\d+/);
  // after the customer cancels (card was charged), deleting anonymises and keeps the order
  await ed.api.post(`/v1/orders/${o.id}/cancel`, { reason: 'test' });
  assert.deepEqual(await admin.api.del(`/v1/admin/users/${e!.id}`), { mode: 'anonymised' });
  const row = (await app.ctx.db.query<{ phone: string; name: string; email: string | null; blocked: boolean; payment_method_id: string | null }>('SELECT phone, name, email, blocked, payment_method_id FROM users WHERE id = $1', [e!.id]))[0]!;
  assert.equal(row.name, 'Deleted user');
  assert.equal(row.email, null);
  assert.equal(row.payment_method_id, null);
  assert.equal(row.blocked, true);
  assert.match(row.phone, /^deleted:/);
  assert.equal((await app.ctx.db.query('SELECT 1 FROM orders WHERE id = $1', [o.id])).length, 1, 'the paid order stays for accounting');
  await expectError(ed.api.get('/v1/me'), 403, 'account_blocked');
  assert.equal((await find('7805550962')).length, 0);
  assert.equal((await app.ctx.db.query(`SELECT 1 FROM users WHERE phone = '+17805550962'`)).length, 0, 'the phone is free again');

  // 3) admins and yourself cannot be deleted
  const me = await admin.api.get('/v1/me');
  await expectError(admin.api.del(`/v1/admin/users/${me.id}`), 400, 'cannot_delete_self');
  // 4) a driver with no jobs: removed with documents and vehicle
  const p = await onboardDriver(app, '7805550963', { name: 'Dmytro Nojobs', tier: 'basic' });
  assert.deepEqual(await admin.api.del(`/v1/admin/users/${p.id}`), { mode: 'deleted' });
  assert.equal((await app.ctx.db.query('SELECT 1 FROM documents WHERE driver_id = $1', [p.id])).length, 0);
  assert.equal((await admin.api.get('/v1/admin/drivers')).some((x: { userId: string }) => x.userId === p.id), false);
});

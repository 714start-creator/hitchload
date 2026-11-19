import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { createHub } from '../src/http/realtime.js';
import { authenticate } from '../src/services/users.js';
import { notify } from '../src/services/notify.js';
import { signIn, startTestApp, type TestApp } from './helpers.js';
import type { AddressInfo } from 'node:net';

let app: TestApp;
before(async () => {
  app = await startTestApp('realtime');
});
after(async () => {
  await app?.close();
});

test('WebSocket delivers notifications to the signed-in user only', async () => {
  const anna = await signIn(app, '7805550123');
  const ctx = { ...app.ctx };
  ctx.hub = createHub((t) => authenticate(ctx, t));
  const server = createApp(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=nope`);
  await new Promise<void>((resolve) => bad.on('error', () => resolve()));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${anna.token}`);
  const got: { type: string; data: any }[] = [];
  ws.on('message', (m) => got.push(JSON.parse(m.toString())));
  await new Promise<void>((r) => ws.on('open', () => r()));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got[0]?.type, 'hello');
  await notify(ctx, anna.user.id, 'delivered', { number: 7 });
  await new Promise((r) => setTimeout(r, 100));
  const n = got.find((g) => g.type === 'notification');
  assert.equal(n?.data.title, 'Delivered');
  assert.match(n?.data.body, /#7/);
  ws.close();
  ctx.hub.close();
  await new Promise((r) => server.close(r));
});

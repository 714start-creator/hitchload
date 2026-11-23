// Browser test of the admin panel against the real server and database.
// Needs Playwright with Chromium and a built admin (cd ../admin && npm run build).
// Run: scripts/with-test-db.sh node --import tsx --test test/e2e/admin-ui.e2e.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { ADMIN_PHONE, client, JPEG, places, signIn, startTestApp, type TestApp } from '../helpers.js';

let app: TestApp;
let browser: Browser;
let page: Page;
let driverId = '';
let orderNumber = 0;
const SHOTS = process.env.SHOTS_DIR;
const hours = (h: number) => new Date(app.ctx.now().getTime() + h * 3_600_000).toISOString();

before(async () => {
  app = await startTestApp('adminui');
  browser = await chromium.launch();
  page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.error('page error:', e));
});
after(async () => {
  await browser?.close();
  await app?.close();
});

async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test('a driver applies (API)', async () => {
  const s = await signIn(app, '7805550444');
  const up = async () => (await s.api.post('/v1/uploads?purpose=document', JPEG, { 'Content-Type': 'image/jpeg' })).key;
  await s.api.patch('/v1/me', { name: 'Taras Melnyk', email: 'taras@example.com', acceptTerms: true });
  await s.api.post('/v1/driver');
  await s.api.patch('/v1/driver', { legalName: 'Taras Melnyk', address: '10220 104 Ave NW, Edmonton AB', dateOfBirth: '1985-02-03', homeCity: 'Edmonton', home: { lat: 53.5461, lng: -113.4938 }, radiusKm: 60 });
  await s.api.post('/v1/driver/vehicles', { type: 'pickup', make: 'Ford', model: 'F-150', year: 2020, plate: 'CTX4444', registeredWeightKg: 3200, hasTrailer: false, equipment: ['straps'] });
  for (const d of [
    { kind: 'license_front' }, { kind: 'license_back' }, { kind: 'registration' }, { kind: 'background_check' }, { kind: 'vehicle_side' }, { kind: 'vehicle_rear' },
    { kind: 'insurance_commercial', insurer: 'Intact', policyNumber: 'P-4444', expiresOn: '2027-06-30' },
    { kind: 'insurance_cargo', insurer: 'Aviva', policyNumber: 'C-4444', coverageCents: 1_000_000, expiresOn: '2027-06-30' },
  ]) await s.api.post('/v1/driver/documents', { ...d, fileKey: await up() });
  // the driver re-uploads the licence front: the old copy must not block the review
  await s.api.post('/v1/driver/documents', { kind: 'license_front', fileKey: await up() });
  await s.api.post('/v1/driver/identity');
  await s.api.post('/v1/driver/payouts');
  const quiz = await s.api.get('/v1/driver/quiz');
  await s.api.post('/v1/driver/agreement', { answers: Object.fromEntries(quiz.map((q: { id: string }) => [q.id, 0])) });
  await s.api.post('/v1/driver/submit');
  const me = await s.api.get('/v1/me');
  driverId = me.id;
  const sessionId = [...app.payments.identity.entries()].find(([, u]) => u === me.id)![0];
  await client(app.url).post('/webhooks/stripe', { id: 'evt_ui', type: 'identity.verification_session.verified', data: { object: { id: sessionId, metadata: { user_id: me.id } } } });
  await s.api.post('/v1/driver/payouts/refresh');
});

test('admin signs in with the SMS code', async () => {
  await page.goto(`${app.url}/admin`);
  await page.fill('#phone', ADMIN_PHONE);
  await page.click('button[type=submit]');
  const hint = await page.locator('small').textContent();
  const code = hint!.match(/\d{6}/)![0];
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await page.getByText('Drivers waiting for review').waitFor();
  const pending = await page.locator('.tile', { hasText: 'Drivers waiting for review' }).locator('.num').textContent();
  assert.equal(pending, '1');
  await shot('1-overview');
});

test('admin reviews documents and approves the driver as Pro', async () => {
  await page.click('header >> text=Drivers');
  await page.getByRole('cell', { name: 'Taras Melnyk' }).click();
  await page.getByText('Ford F-150').waitFor();
  // what is missing is listed before anything is clicked; plain Approve is disabled
  await page.locator('.notice-box', { hasText: 'Criminal record check accepted' }).waitFor();
  assert.equal(await page.locator('#approve').isDisabled(), true);
  const docs = page.locator('.docs').first().locator('.doc');
  assert.equal(await docs.count(), 8, 'eight current documents');
  await page.locator('details', { hasText: 'Replaced by newer uploads (1)' }).waitFor();
  // accept the record check by itself: that alone makes it "accepted"
  await docs.filter({ hasText: 'Criminal record check' }).getByRole('button', { name: 'Accept' }).click();
  await page.locator('.toast-admin', { hasText: 'Criminal record check: accepted' }).waitFor();
  await page.locator('.checks li.done', { hasText: 'Criminal record check accepted' }).waitFor();
  const img = page.locator('.doc img').first();
  await img.waitFor();
  assert.ok(await img.evaluate((el) => (el as { complete: boolean }).complete));
  await page.selectOption('#tier', 'pro');
  await page.getByText('Pro: no cargo value limit').waitFor();
  assert.equal(await page.locator('#cargo').count(), 0);
  await page.click('#approve-all');
  await page.locator('h2 .pill', { hasText: 'approved' }).waitFor();
  await page.getByText('Everything is in place').waitFor();
  await shot('2-driver');
  const d = await (await signIn(app, ADMIN_PHONE)).api.get(`/v1/admin/drivers/${driverId}`);
  assert.equal(d.driver.status, 'approved');
  assert.equal(d.driver.tier, 'pro');
  assert.equal(d.driver.cargoLimitCents, 1_000_000);
});

test('an order is delivered and the customer opens a dispute (API)', async () => {
  const anna = await signIn(app, '7805550123');
  await anna.api.patch('/v1/me', { name: 'Anna K', email: 'anna@example.com', acceptTerms: true });
  const setup = await anna.api.post('/v1/me/card/setup');
  app.payments.addCard(setup.customerId);
  await anna.api.post('/v1/me/card/sync');
  const o = await anna.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.whyteAve, size: 'M', declaredValueCents: 5000, insured: false, windowStart: hours(3), windowEnd: hours(5), priceCents: 6000, description: 'Комод' });
  orderNumber = o.number;
  const drv = await signIn(app, '7805550444');
  await drv.api.post(`/v1/driver/orders/${o.id}/take`);
  const pin = (await anna.api.get(`/v1/orders/${o.id}`)).pin;
  const photo = (await drv.api.post('/v1/uploads?purpose=pickup', JPEG, { 'Content-Type': 'image/jpeg' })).key;
  await drv.api.post(`/v1/driver/orders/${o.id}/pickup`, { photoKeys: [photo] });
  await drv.api.post(`/v1/driver/orders/${o.id}/deliver`, { pin });
  await anna.api.post(`/v1/orders/${o.id}/messages`, { body: 'Позвони мне 780 555 1234' });
  await anna.api.post(`/v1/orders/${o.id}/disputes`, { reason: 'Царапина на крышке комода' });
});

test('admin finds the order and sees money, timeline and chat', async () => {
  await page.click('header >> text=Orders');
  await page.fill('#search', String(orderNumber));
  await page.click('button:has-text("Search")');
  await page.getByRole('cell', { name: String(orderNumber), exact: true }).click();
  await page.getByText(`Order #${orderNumber}`).waitFor();
  assert.match(await page.locator('.money').textContent() ?? '', /Agreed \(to driver\)\$60\.00/);
  await page.getByText('delivered', { exact: true }).first().waitFor();
  await page.locator('.pill', { hasText: 'contact hidden' }).waitFor();
  await page.locator('.timeline li').first().waitFor();
  await shot('3-order');
});

test('admin resolves the dispute with a partial refund', async () => {
  await page.click('header >> text=Disputes');
  await page.getByText('Царапина на крышке комода').waitFor();
  await page.getByLabel('Resolution (sent to both sides)').fill('Частичный возврат $15 за царапину');
  await page.getByLabel('Action').selectOption('refund');
  await page.getByLabel('Refund, $').fill('15');
  await shot('4-dispute');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.getByText('No disputes.').waitFor();
  await page.getByRole('button', { name: 'resolved', exact: true }).click();
  await page.getByText('Resolved: Частичный возврат $15 за царапину').waitFor();
  const refund = app.payments.calls.filter((c) => c.op === 'refund').at(-1)!.args as { amountCents: number };
  assert.equal(refund.amountCents, 1500);
});

test('admin exports the CRA report', async () => {
  await page.click('header >> text=Reports');
  await page.fill('#year', String(new Date(app.ctx.now()).getUTCFullYear()));
  await page.click('button:has-text("Prepare CSV")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("Download")')]);
  const csv = await readFile((await dl.path())!, 'utf8');
  assert.match(csv, /^driver_id,legal_name/);
  assert.match(csv, /Taras Melnyk/);
  assert.match(csv, /,yes\n$/); // no SIN yet
  await shot('5-reports');
});

test('admin finds a user and deletes them', async () => {
  const s = await signIn(app, '7805550777');
  await s.api.patch('/v1/me', { name: 'Zoya Testova', email: 'zoya@example.com', acceptTerms: true });
  await page.click('header >> text=Users');
  await page.fill('#user-search', 'Zoya');
  await page.click('button:has-text("Search")');
  const row = page.locator('tr[data-user="+17805550777"]');
  await row.waitFor();
  await shot('6-users');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.accept(); });
  await row.locator('button.delete-user').click();
  await page.locator('.toast-admin.ok', { hasText: 'deleted completely' }).waitFor();
  assert.match(asked, /Delete Zoya Testova/);
  await row.waitFor({ state: 'detached' });
  // the admin's own row has no Delete button
  await page.fill('#user-search', '');
  await page.click('button:has-text("Search")');
  await page.locator(`tr[data-user="${ADMIN_PHONE}"]`).waitFor();
  assert.equal(await page.locator(`tr[data-user="${ADMIN_PHONE}"] button.delete-user`).count(), 0);
});

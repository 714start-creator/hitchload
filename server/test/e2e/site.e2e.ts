// Browser test of the public website against the real server and database.
// Needs the site built (cd ../web && npm run build) and Playwright with Chromium.
// Run: scripts/with-test-db.sh node --import tsx --test test/e2e/site.e2e.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { customer, onboardDriver, places, startTestApp, type TestApp } from '../helpers.js';

let app: TestApp;
let browser: Browser;
let shipperCtx: BrowserContext;
let driverCtx: BrowserContext;
let shipper: Page;
let driverPage: Page;
let mike: Awaited<ReturnType<typeof onboardDriver>>;
let orderId = '';
let pin = '';
const SHOTS = process.env.SHOTS_DIR;
const errors: string[] = [];
const PHOTO = path.join(tmpdir(), 'hl-photo.jpg');

before(async () => {
  app = await startTestApp('site', { realtime: true });
  writeFileSync(PHOTO, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(400).fill(7), 0xff, 0xd9]));
  browser = await chromium.launch();
  shipperCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' });
  driverCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-CA' });
  // the map CDN is not reachable from the test sandbox: fail fast so the schematic map is used
  for (const c of [shipperCtx, driverCtx]) await c.route(/unpkg\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  shipper = await shipperCtx.newPage();
  driverPage = await driverCtx.newPage();
  for (const p of [shipper, driverPage]) {
    p.on('pageerror', (e) => errors.push(String(e)));
    // files.test is the test storage host (not same-origin, so CSP blocks its images); production storage is same-origin or https
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|files\.test/.test(m.text())) errors.push(m.text()); });
  }
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const hours = (h: number) => new Date(app.ctx.now().getTime() + h * 3_600_000).toISOString();

async function signInUi(p: Page, phone: string, profile?: { name: string; email: string }) {
  await p.fill('#phone', phone);
  await p.click('button[type=submit]');
  const hint = await p.locator('.notice', { hasText: /code/i }).textContent();
  await p.fill('#code', /\d{6}/.exec(hint!)![0]);
  await p.click('button[type=submit]');
  if (profile) {
    await p.fill('#name', profile.name);
    await p.fill('#email', profile.email);
    await p.check('#terms');
    await p.click('button[type=submit]');
  }
}

test('home page: hero, route search, live trips', async () => {
  mike = await onboardDriver(app, '7805550200', { name: 'Mike Shevchuk', tier: 'pro' });
  await mike.api.post('/v1/driver/trips', { stops: [{ city: 'Edmonton', province: 'AB' }, { city: 'Red Deer', province: 'AB' }, { city: 'Calgary', province: 'AB' }], departAt: hours(3) });
  await shipper.goto(app.url + '/');
  await shipper.getByRole('heading', { name: /already going your way/ }).waitFor();
  assert.equal(await shipper.locator('.site-head .sign').textContent(), 'HITCHLOAD');
  await shipper.fill('#search-from', 'Edmonton, AB');
  await shipper.fill('#search-to', 'Calgary, AB');
  await shot(shipper, 'site-1-home');
  await shipper.click('button:has-text("Find drivers")');
  await shipper.waitForURL(/\/send\?from=Edmonton/);
  await shipper.getByText('1 trip on this route').waitFor();
  await shipper.locator('.trip', { hasText: 'Mike' }).waitFor();
  await shipper.locator('.map').first().waitFor();
  await shot(shipper, 'site-2-send');
});

test('a new customer signs up from the route alert and saves the alert', async () => {
  await shipper.click('#alert-save');
  await shipper.waitForURL(/\/sign-in\?next=/);
  await signInUi(shipper, '7805550123', { name: 'Anna Kovalenko', email: 'anna@example.com' });
  await shipper.waitForURL(/\/send\?from=Edmonton/);
  await shipper.click('#alert-save');
  await shipper.getByText('We will tell you about new drivers on Edmonton → Calgary').waitFor();
  const token = await shipper.evaluate<string | null>('localStorage.getItem("hl.token")');
  const alerts = (await (await fetch(app.url + '/v1/alerts', { headers: { Authorization: `Bearer ${token}` } })).json()) as unknown[];
  assert.equal(alerts.length, 1);
  assert.ok(app.emails.some((m) => m.to === 'anna@example.com'), 'confirmation email');
});

test('books the trip: order form, test card, request to the driver', async () => {
  await shipper.locator('.trip', { hasText: 'Mike' }).getByRole('button', { name: 'Send with this driver' }).click();
  await shipper.waitForURL(/\/send\/new\?.*trip=/);
  await shipper.fill('#pickup-street', '10405 82 Ave NW');
  assert.equal(await shipper.inputValue('#pickup-city'), 'Edmonton, AB');
  await shipper.fill('#dropoff-street', '1121 Kensington Rd NW');
  await shipper.fill('#description', 'Bike in a box');
  await shipper.locator('.size', { hasText: 'Up to 25 kg' }).click();
  await shipper.setInputFiles('input[type=file]', PHOTO);
  await shipper.locator('.thumb img').waitFor();
  // a wide window so the driver's pass time fits
  const local = new Date(Date.now() + 3600_000);
  await shipper.fill('#date', `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
  await shipper.fill('#from', '00:00');
  await shipper.fill('#to', '23:59');
  await shipper.getByText(/Booking on Mike/).waitFor();
  await shot(shipper, 'site-3-order-form');
  await shipper.click('#submit-order');
  await shipper.getByRole('button', { name: /save a test card/ }).click();
  await shipper.getByRole('button', { name: /Send request to Mike/ }).click();
  await shipper.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  orderId = shipper.url().split('/').pop()!;
  await shipper.getByText(/Waiting for the driver to confirm/).waitFor();
  await shot(shipper, 'site-4-order-open');
});

test('driver signs in, sees the request on the dashboard and takes it; the customer page updates live', async () => {
  await driverPage.goto(app.url + '/sign-in?next=/driver');
  await signInUi(driverPage, '7805550200');
  await driverPage.waitForURL(/\/driver$/);
  await driverPage.locator('.card', { hasText: 'Request for your trip' }).click();
  await driverPage.waitForURL(new RegExp(`/driver/jobs/${orderId}`));
  await driverPage.click('#take');
  await driverPage.locator('.pill', { hasText: 'Driver confirmed' }).waitFor();
  // customer sees the change without reloading
  await shipper.locator('.pill', { hasText: 'Driver confirmed' }).waitFor();
  pin = (await shipper.locator('#order-pin').textContent())!.trim();
  assert.match(pin, /^\d{4}$/);
  await shipper.locator('.toast', { hasText: 'Order confirmed' }).waitFor();
  await shot(shipper, 'site-5-order-confirmed');
});

test('chat hides contacts; pickup with a photo, delivery by PIN, rating', async () => {
  await shipper.fill('input[placeholder="Message…"]', 'Call me at 780 555 1234');
  await shipper.click('.card:has(.chat) button[type=submit]');
  await driverPage.locator('.msg', { hasText: 'Call me at [contact hidden]' }).waitFor();
  await driverPage.click('#en-route');
  await driverPage.setInputFiles('#pickup-photos', PHOTO);
  await driverPage.locator('.thumb img').first().waitFor();
  await driverPage.click('#picked-up');
  await driverPage.click('#depart');
  await driverPage.fill('#pin', '0000' === pin ? '1111' : '0000');
  await driverPage.click('#deliver');
  await driverPage.getByText(/Wrong PIN/).waitFor();
  await driverPage.fill('#pin', pin);
  await driverPage.click('#deliver');
  await driverPage.locator('.pill', { hasText: 'Delivered' }).waitFor();
  await shot(driverPage, 'site-6-job-delivered');
  await shipper.locator('.pill', { hasText: 'Delivered' }).waitFor();
  await shipper.locator('.stars button').nth(4).click();
  await shipper.click('button:has-text("Send rating")');
  await shipper.getByText('Thanks for the rating').waitFor();
});

test('driver posts a trip; the customer with a matching alert is notified', async () => {
  await driverPage.goto(app.url + '/driver/trips');
  await driverPage.fill('#stop-0', 'Edmonton, AB');
  await driverPage.fill('#stop-1', 'Calgary, AB');
  await driverPage.click('#add-stop');
  await driverPage.fill('#stop-1', 'Red Deer, AB');
  await driverPage.click('#publish-trip');
  await driverPage.getByText(/Trip posted. Loads on the way: 0. Shippers notified: 1/).waitFor();
  await shot(driverPage, 'site-7-trips');
  await shipper.locator('.toast', { hasText: 'New driver on your route' }).waitFor();
  await shipper.goto(app.url + '/notifications');
  await shipper.locator('.note', { hasText: 'New driver on your route' }).click();
  await shipper.waitForURL(/\/send\?from=Edmonton%2C\+AB&to=Calgary%2C\+AB&trip=/);
  await shipper.locator('.trip.hl').first().waitFor();
});

test('driver: a trip around one city, loads split into "On your way" and "All loads", any load can be taken', async () => {
  await driverPage.goto(app.url + '/driver/trips');
  await driverPage.fill('#stop-0', 'Edmonton, AB');
  await driverPage.fill('#stop-1', 'Edmonton, AB');
  await driverPage.click('#publish-trip');
  await driverPage.getByText(/Trip posted\./).waitFor();
  const far = await customer(app, '7805550888', 'Sam Far');
  const o = await far.api.post('/v1/orders', { pickup: places.saskatoon, dropoff: { ...places.saskatoon, address: '100 3rd Ave S', lat: 52.124, lng: -106.664 }, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(1), windowEnd: hours(8), priceCents: 2500 });
  const local = await far.api.post('/v1/orders', { pickup: places.ikeaEdmonton, dropoff: places.secord, size: 'S', declaredValueCents: 0, insured: false, windowStart: hours(1), windowEnd: hours(8), priceCents: 3000 });
  app.advance(5 * 60_000); // past the Pro window for city orders
  await driverPage.goto(app.url + '/driver');
  await driverPage.locator('#tab-way').waitFor();
  await driverPage.locator(`a[href="/driver/jobs/${local.id}"]`).waitFor();
  await driverPage.click('#tab-all');
  await driverPage.locator(`a[href="/driver/jobs/${o.id}"]`).click();
  await driverPage.click('#take');
  await driverPage.locator('.pill', { hasText: 'Driver confirmed' }).waitFor();
  await shot(driverPage, 'site-7b-feed-take-far');
});

test('email confirmation link from the account page', async () => {
  await shipper.goto(app.url + '/account');
  await shipper.getByText('Email not confirmed').waitFor();
  const m = [...app.emails].reverse().find((e) => e.to === 'anna@example.com' && /Confirm/.test(e.subject))!;
  const link = /(https?:\/\/\S+\/v1\/auth\/email\/verify\?\S+)/.exec(m.text)![1]!.replace(app.ctx.cfg.publicUrl, app.url);
  // the server redirects to PUBLIC_URL; in tests follow it by hand
  const res = await fetch(link, { redirect: 'manual' });
  await shipper.goto(app.url + res.headers.get('location')!.replace(app.ctx.cfg.publicUrl, ''));
  await shipper.waitForURL(/\/account\?email=verified/);
  await shipper.getByText('Email confirmed').waitFor();
  await shipper.locator('a', { hasText: 'Edmonton → Calgary' }).waitFor();
  await shot(shipper, 'site-8-account');
});

test('a new driver completes the application on the website', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/unpkg\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(app.url + '/drive');
  await p.getByRole('link', { name: 'Apply to drive' }).click();
  await p.waitForURL(/\/sign-in/);
  await signInUi(p, '7805550777', { name: 'Taras Melnyk', email: 'taras@example.com' });
  await p.waitForURL(/\/driver\/setup/);
  await p.click('button:has-text("Start the application")');
  await p.fill('#legal-name', 'Taras Melnyk');
  await p.fill('#dob', '1985-02-03');
  await p.fill('#home-address', '10220 104 Ave NW, Edmonton AB');
  await p.fill('#home-city', 'Edmonton, AB');
  await p.click('#save-profile');
  await p.locator('.checks li.done', { hasText: 'Personal details' }).waitFor();
  await p.selectOption('#vehicle-type', 'cargo_van');
  await p.fill('#make', 'Ford');
  await p.fill('#model', 'Transit');
  await p.fill('#year', '2020');
  await p.fill('#plate', 'cxz123');
  await p.fill('#gvw', '3500');
  await p.click('#add-vehicle');
  await p.locator('.checks li.done', { hasText: 'Vehicle' }).waitFor();
  for (const k of ['license_front', 'license_back', 'registration', 'background_check']) {
    await p.setInputFiles(`#doc-${k}`, PHOTO);
    await p.locator('.doc', { has: p.locator(`#doc-${k}`) }).locator('.pill', { hasText: 'Under review' }).waitFor();
  }
  await p.selectOption('#ins-kind', 'insurance_endorsement');
  await p.fill('#ins-insurer', 'Intact');
  await p.fill('#ins-policy', 'P-777');
  await p.fill('#ins-expires', '2027-12-31');
  await p.setInputFiles('#ins-file', PHOTO);
  await p.locator('#ins-save:not([disabled])').click();
  await p.locator('.checks li.done', { hasText: 'Insurance that covers deliveries' }).waitFor();
  await p.click('button:has-text("Start the check")');
  await p.waitForURL(/\/driver\/setup\?done=identity/);
  await p.locator('.checks li.done', { hasText: 'ID verified by Stripe' }).waitFor();
  await p.click('button:has-text("Set up payouts")');
  await p.waitForURL(/\/driver\/setup\?done=payouts/);
  await p.locator('details.section', { hasText: 'Payout account' }).locator('.num.done').waitFor();
  for (const fs of await p.locator('fieldset.quiz').all()) await fs.locator('input[type=radio]').first().check();
  await p.check('#agree-rules');
  await p.click('#submit-quiz');
  await p.locator('.checks li.done', { hasText: 'Rules and quiz' }).waitFor();
  await shot(p, 'site-9-driver-setup');
  await p.click('#submit-driver');
  await p.getByText('Under review (usually 1–2 business days)').first().waitFor();
  await ctx.close();
});

test('mobile layout, Russian, static pages and 404', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route(/unpkg\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(app.url + '/');
  await p.getByRole('heading', { name: /already going your way/ }).waitFor();
  const overflow = await p.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth + 1');
  assert.equal(overflow, false, 'no horizontal scroll on a phone');
  await shot(p, 'site-10-mobile-home');
  await p.click('button[aria-label=Language]');
  await p.getByRole('heading', { name: /уже едет в ту сторону/ }).waitFor();
  await p.goto(app.url + '/pricing');
  await p.getByRole('heading', { name: 'Цены и комиссии' }).waitFor();
  await shot(p, 'site-11-mobile-pricing-ru');
  for (const path of ['/terms', '/privacy', '/safety', '/faq', '/how-it-works', '/loads']) {
    await p.goto(app.url + path);
    await p.locator('h1').first().waitFor();
  }
  await p.goto(app.url + '/nope');
  await p.getByText('Страница не найдена').waitFor();
  const robots = await (await fetch(app.url + '/robots.txt')).text();
  assert.match(robots, /Sitemap: http/);
  const sitemap = await (await fetch(app.url + '/sitemap.xml')).text();
  assert.match(sitemap, /<loc>[^<]+\/send<\/loc>/);
  await ctx.close();
});

test('no script errors on any page', () => {
  assert.deepEqual(errors, []);
});

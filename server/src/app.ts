// Wires config, database, providers and the HTTP server together.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import type { Db } from './db/db.js';
import { createHub, type Hub } from './http/realtime.js';
import { createLogEmail, createPostmarkEmail, createResendEmail, type Email } from './providers/email.js';
import { createFakePayments, createStripePayments, type Payments } from './providers/payments.js';
import { createExpoPush, createLogPush, type Push } from './providers/push.js';
import { createLocalSms, createTwilioSms, type Sms } from './providers/sms.js';
import { createDbStorage, createLocalStorage, createS3Storage, type Storage } from './providers/storage.js';
import { createLogWebPush, createVapidPush, type WebPush } from './providers/webpush.js';
import { buildRouter } from './routes.js';
import { authenticate } from './services/users.js';

export interface AppOverrides {
  payments?: Payments;
  sms?: Sms;
  push?: Push;
  storage?: Storage;
  email?: Email;
  webPush?: WebPush;
  hub?: Hub;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export function createContext(cfg: Config, db: Db, o: AppOverrides = {}): Ctx {
  const log = o.log ?? ((m: string, extra?: unknown) => (extra === undefined ? console.log(m) : console.error(m, extra)));
  const payments = o.payments ?? (cfg.stripe.secretKey ? createStripePayments(cfg.stripe.secretKey, cfg.stripe.webhookSecret) : createFakePayments());
  const t = cfg.twilio;
  const sms = o.sms ?? (t.accountSid && t.authToken && t.verifyServiceSid
    ? createTwilioSms({ accountSid: t.accountSid, authToken: t.authToken, verifyServiceSid: t.verifyServiceSid, fromNumber: t.fromNumber })
    : createLocalSms(db, { exposeCode: !cfg.prod, log }));
  const push = o.push ?? (cfg.prod || process.env.EXPO_PUSH === '1' ? createExpoPush(cfg.expoAccessToken) : createLogPush());
  const s = cfg.storage;
  const storage = o.storage ?? (s.bucket && s.accessKeyId && s.secretAccessKey
    ? createS3Storage({ bucket: s.bucket, region: s.region, endpoint: s.endpoint, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey })
    // no S3: keep files in the database on Render (its disk is wiped on restart) or when STORAGE_DRIVER=db
    : process.env.STORAGE_DRIVER === 'db' || (process.env.RENDER && process.env.STORAGE_DRIVER !== 'local') ? createDbStorage(db, cfg.publicUrl, cfg.jwtSecret)
    : createLocalStorage(s.localDir, cfg.publicUrl, cfg.jwtSecret));
  const e = cfg.email;
  const email = o.email ?? (e.provider === 'resend' && e.apiKey ? createResendEmail(e.apiKey, e.from)
    : e.provider === 'postmark' && e.apiKey ? createPostmarkEmail(e.apiKey, e.from)
    : createLogEmail([], cfg.prod ? undefined : (m) => log(m)));
  const w = cfg.webPush;
  const webPush = o.webPush ?? (w.publicKey && w.privateKey ? createVapidPush(w.publicKey, w.privateKey, w.subject) : createLogWebPush());
  const ctx: Ctx = {
    cfg, db, payments, sms, push, storage, email, webPush, log,
    hub: o.hub ?? createHub((token) => authenticate(ctx, token)),
    now: o.now ?? (() => new Date()),
    timeZone: process.env.TZ_DISPLAY ?? 'America/Edmonton',
  };
  if (cfg.prod) {
    for (const [name, p] of [['payments', payments.kind === 'fake'], ['sms', sms.kind === 'local'], ['storage', storage.kind !== 's3'], ['email', email.kind === 'log']] as const)
      if (p) log(`WARNING: ${name} is running on a local stand-in in production`);
  }
  return ctx;
}

export function createApp(ctx: Ctx): Server {
  const router = buildRouter(ctx);
  const server = createServer(async (req, res) => {
    // local file storage (development)
    if (req.method === 'GET' && req.url?.startsWith('/files/') && ctx.storage.readLocal) {
      const url = new URL(req.url, 'http://localhost');
      const key = decodeURIComponent(url.pathname.slice('/files/'.length));
      const buf = await ctx.storage.readLocal(key, url.searchParams.get('exp') ?? '0', url.searchParams.get('sig') ?? '');
      if (!buf) {
        res.writeHead(404).end();
        return;
      }
      const ext = key.split('.').pop() ?? '';
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' }[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=600' }).end(buf);
      return;
    }
    // admin web panel (static build of ../admin)
    if (req.method === 'GET' && (req.url === '/admin' || req.url?.startsWith('/admin/'))) {
      await serveAdmin(req.url, res);
      return;
    }
    // the public website (static build of ../web); unknown paths get index.html (client-side routing)
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url && isSitePath(req.url)) {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /orders\nDisallow: /driver\nDisallow: /notifications\nDisallow: /o/\nSitemap: ${ctx.cfg.publicUrl}/sitemap.xml\n`);
        return;
      }
      if (req.url.startsWith('/sitemap.xml')) {
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' }).end(sitemap(ctx.cfg.publicUrl));
        return;
      }
      await serveSite(req.url, res);
      return;
    }
    await router.handle(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/v1/ws')) ctx.hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}

const ADMIN_DIR = resolve(process.env.ADMIN_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../admin/dist'));
const ADMIN_TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' };

async function serveAdmin(url: string, res: import('node:http').ServerResponse) {
  if (url === '/admin') {
    res.writeHead(301, { Location: '/admin/' }).end();
    return;
  }
  const path = new URL(url, 'http://x').pathname.slice('/admin/'.length) || 'index.html';
  const file = normalize(join(ADMIN_DIR, decodeURIComponent(path)));
  if (!file.startsWith(ADMIN_DIR)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': ADMIN_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Admin panel is not built. Run: cd admin && npm run build');
  }
}

const API_PREFIXES = ['/v1/', '/webhooks/', '/return/', '/files/', '/admin', '/health'];
const isSitePath = (url: string) => !API_PREFIXES.some((p) => url === p.replace(/\/$/, '') || url.startsWith(p));

const WEB_DIR = resolve(process.env.WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'));
const SITE_TYPES: Record<string, string> = { ...ADMIN_TYPES, ico: 'image/x-icon', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', json: 'application/json', woff2: 'font/woff2', jpg: 'image/jpeg', webp: 'image/webp' };
const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss: https://api.stripe.com https://places.googleapis.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

async function serveSite(url: string, res: import('node:http').ServerResponse) {
  const path = decodeURIComponent(new URL(url, 'http://x').pathname);
  const file = normalize(join(WEB_DIR, path));
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': SITE_CSP, 'X-Frame-Options': 'DENY' };
  if (file.startsWith(WEB_DIR + '/') && /\.[a-z0-9]+$/i.test(path)) {
    try {
      const body = await readFile(file);
      const ext = file.split('.').pop() ?? '';
      const immutable = /\.[0-9a-f]{8,}\./.test(path);
      res.writeHead(200, { ...headers, 'Content-Type': SITE_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }).end(body);
      return;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
  }
  try {
    const body = await readFile(join(WEB_DIR, 'index.html'));
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Website is not built. Run: cd web && npm run build');
  }
}

function sitemap(base: string): string {
  const pages = ['/', '/send', '/drive', '/loads', '/how-it-works', '/pricing', '/safety', '/faq', '/terms', '/privacy'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`;
}

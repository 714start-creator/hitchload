// Small HTTP router on node:http: path params, JSON bodies, auth, errors, CORS.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, type ZodTypeAny } from 'zod';
import { HttpError, bad, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  lang: string;
  isAdmin: boolean;
  blocked: boolean;
}

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  raw: Buffer;
  ip: string;
  user: AuthUser | null;
}

export class RawResponse {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: Buffer | string,
  ) {}
}

type Access = 'public' | 'user' | 'admin';
type Handler = (req: Req) => Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  access: Access;
  rawBody: boolean;
  maxBytes: number;
}

export interface RouterOpts {
  authenticate: (token: string) => Promise<AuthUser | null>;
  corsOrigins: string[];
  log: (msg: string, extra?: unknown) => void;
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw bad('validation_failed', issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; '), issues);
  }
  return r.data;
}

export class Router {
  private routes: Route[] = [];
  constructor(private opts: RouterOpts) {}

  add(method: string, pattern: string, handler: Handler, o: { access?: Access; rawBody?: boolean; maxBytes?: number } = {}) {
    this.routes.push({
      method,
      parts: pattern.split('/').filter(Boolean),
      handler,
      access: o.access ?? 'user',
      rawBody: o.rawBody ?? false,
      maxBytes: o.maxBytes ?? 1_000_000,
    });
  }
  get = (p: string, h: Handler, o?: Parameters<Router['add']>[3]) => this.add('GET', p, h, o);
  post = (p: string, h: Handler, o?: Parameters<Router['add']>[3]) => this.add('POST', p, h, o);
  patch = (p: string, h: Handler, o?: Parameters<Router['add']>[3]) => this.add('PATCH', p, h, o);
  delete = (p: string, h: Handler, o?: Parameters<Router['add']>[3]) => this.add('DELETE', p, h, o);

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i] as string;
        const s = segs[i] as string;
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
        else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route: r, params };
    }
    return methodMismatch ? 'method' : null;
  }

  private cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = this.opts.corsOrigins.includes('*') || this.opts.corsOrigins.includes(origin);
    if (!allowed) return;
    res.setHeader('Access-Control-Allow-Origin', this.opts.corsOrigins.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    this.cors(req, res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      const m = this.match(method, url.pathname);
      if (m === null) throw new HttpError(404, 'not_found', 'No such endpoint');
      if (m === 'method') throw new HttpError(405, 'method_not_allowed');
      const { route, params } = m;
      const raw = await readBody(req, route.maxBytes);
      let body: unknown = undefined;
      if (!route.rawBody && raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw bad('invalid_json', 'Body must be JSON');
        }
      }
      let user: AuthUser | null = null;
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) user = await this.opts.authenticate(auth.slice(7));
      if (route.access !== 'public') {
        if (!user) throw unauthorized();
        if (user.blocked) throw new HttpError(403, 'account_blocked', 'This account is blocked');
        if (route.access === 'admin' && !user.isAdmin) throw new HttpError(403, 'forbidden');
      }
      const out = await route.handler({
        method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: req.headers,
        body,
        raw,
        ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '',
        user,
      });
      if (out instanceof RawResponse) {
        res.writeHead(out.status, out.headers).end(out.body);
      } else {
        const json = JSON.stringify(out ?? { ok: true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(json);
      }
    } catch (e) {
      const err = e instanceof HttpError ? e : null;
      if (!err) this.opts.log(`unhandled error ${method} ${url.pathname}`, e);
      const status = err?.status ?? 500;
      const payload = { error: { code: err?.code ?? 'internal_error', message: err?.message ?? 'Something went wrong on our side', details: err?.details } };
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } finally {
      if (process.env.LOG_REQUESTS === '1') this.opts.log(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'payload_too_large', `Body is larger than ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Simple fixed-window rate limiter kept in memory. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  check(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

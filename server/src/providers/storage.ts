// File storage for photos and documents: S3-compatible (AWS S3, Cloudflare R2,
// DigitalOcean Spaces) with SigV4, or local disk for development.
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/db.js';

export interface Storage {
  readonly kind: 's3' | 'local' | 'db';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Time-limited URL to view a file. */
  url(key: string, ttlSec?: number): string;
  /** Local storage only: read a file after checking its signed URL. */
  readLocal?(key: string, exp: string, sig: string): Promise<Buffer | null>;
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (key: string) => key.split('/').map(enc).join('/');

function amzDate(d: Date) {
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amz: iso, day: iso.slice(0, 8) };
}

function signingKey(secret: string, day: string, region: string) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
}

export interface S3Opts {
  bucket: string;
  region: string;
  endpoint?: string; // e.g. https://<account>.r2.cloudflarestorage.com ; default AWS virtual-host style
  accessKeyId: string;
  secretAccessKey: string;
  /** Override the virtual-hosted host name (e.g. the legacy global endpoint). */
  virtualHost?: string;
}

function hostAndPath(o: S3Opts, key: string) {
  if (o.endpoint) {
    const u = new URL(o.endpoint);
    return { origin: `${u.protocol}//${u.host}`, host: u.host, path: `/${o.bucket}/${encPath(key)}` };
  }
  const host = o.virtualHost ?? `${o.bucket}.s3.${o.region}.amazonaws.com`;
  return { origin: `https://${host}`, host, path: `/${encPath(key)}` };
}

/** SigV4 query-string presigned GET URL. */
export function presignGet(o: S3Opts, key: string, ttlSec: number, now = new Date()): string {
  const { origin, host, path: p } = hostAndPath(o, key);
  const { amz, day } = amzDate(now);
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const q: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.accessKeyId}/${scope}`],
    ['X-Amz-Date', amz],
    ['X-Amz-Expires', String(ttlSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonQuery = q.map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const canonical = ['GET', p, canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const sig = hmac(signingKey(o.secretAccessKey, day, o.region), toSign).toString('hex');
  return `${origin}${p}?${canonQuery}&X-Amz-Signature=${sig}`;
}

export function createS3Storage(o: S3Opts): Storage {
  return {
    kind: 's3',
    async put(key, body, contentType) {
      const { origin, host, path: p } = hostAndPath(o, key);
      const { amz, day } = amzDate(new Date());
      const scope = `${day}/${o.region}/s3/aws4_request`;
      const payloadHash = sha256hex(body);
      const headers: [string, string][] = [
        ['content-type', contentType],
        ['host', host],
        ['x-amz-content-sha256', payloadHash],
        ['x-amz-date', amz],
      ];
      const signed = headers.map(([k]) => k).join(';');
      const canonical = ['PUT', p, '', headers.map(([k, v]) => `${k}:${v}\n`).join(''), signed, payloadHash].join('\n');
      const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
      const sig = hmac(signingKey(o.secretAccessKey, day, o.region), toSign).toString('hex');
      const res = await fetch(origin + p, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amz,
          Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
        },
        body: new Uint8Array(body),
      });
      if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
    },
    url: (key, ttlSec = 900) => presignGet(o, key, ttlSec),
  };
}

export function createLocalStorage(dir: string, publicUrl: string, secret: string): Storage {
  const sign = (key: string, exp: string) => createHmac('sha256', secret).update(`${key}:${exp}`).digest('base64url');
  const safe = (key: string) => {
    const full = path.resolve(dir, key);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('bad key');
    return full;
  };
  return {
    kind: 'local',
    async put(key, body) {
      const full = safe(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    url(key, ttlSec = 900) {
      const exp = String(Math.floor(Date.now() / 1000) + ttlSec);
      return `${publicUrl}/files/${encPath(key)}?exp=${exp}&sig=${sign(key, exp)}`;
    },
    async readLocal(key, exp, sig) {
      if (Number(exp) < Date.now() / 1000 || sign(key, exp) !== sig) return null;
      try {
        return await readFile(safe(key));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Files in Postgres (bytea). For test servers without S3 whose disk does not survive a restart.
 * Same signed-URL scheme as local storage, served by the app at /files/.
 */
export function createDbStorage(db: Db, publicUrl: string, secret: string): Storage {
  const sign = (key: string, exp: string) => createHmac('sha256', secret).update(`${key}:${exp}`).digest('base64url');
  return {
    kind: 'db',
    async put(key, body, contentType) {
      await db.query(
        `INSERT INTO stored_files(key, content_type, body) VALUES ($1, $2, decode($3, 'base64'))
         ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, content_type = EXCLUDED.content_type`,
        [key, contentType, body.toString('base64')],
      );
    },
    url(key, ttlSec = 900) {
      const exp = String(Math.floor(Date.now() / 1000) + ttlSec);
      return `${publicUrl}/files/${encPath(key)}?exp=${exp}&sig=${sign(key, exp)}`;
    },
    async readLocal(key, exp, sig) {
      if (Number(exp) < Date.now() / 1000 || sign(key, exp) !== sig) return null;
      const rows = await db.query<{ b64: string }>(`SELECT encode(body, 'base64') AS b64 FROM stored_files WHERE key = $1`, [key]);
      return rows[0] ? Buffer.from(rows[0].b64.replace(/\s/g, ''), 'base64') : null;
    },
  };
}

// Production database adapter on node-postgres.
import pg from 'pg';
import type { Db, Queryable } from './db.js';

const OID = { int8: 20, date: 1082, timestamp: 1114, timestamptz: 1184 } as const;

function isoFromPg(v: string): string {
  // '2026-10-28 04:26:48.951+00' -> ISO
  const s = v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  return new Date(s).toISOString();
}

let parsersSet = false;
function setParsers() {
  if (parsersSet) return;
  pg.types.setTypeParser(OID.int8, (v) => Number(v));
  pg.types.setTypeParser(OID.date, (v) => v);
  pg.types.setTypeParser(OID.timestamptz, isoFromPg);
  pg.types.setTypeParser(OID.timestamp, (v) => isoFromPg(v + '+00'));
  parsersSet = true;
}

export function createPgDb(connectionString: string): Db {
  setParsers();
  const ssl = /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, ssl, max: 10, options: '-c timezone=UTC' });
  pool.on('error', (e) => console.error('pg pool error', e));
  type Conn = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
  const wrap = (c: Conn): Queryable => ({
    async query<R>(text: string, params?: unknown[]) {
      const res = await c.query(text, params);
      return res.rows as R[];
    },
  });
  const base = wrap(pool);
  return {
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

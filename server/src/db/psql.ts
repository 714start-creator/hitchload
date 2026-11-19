// Test/dev adapter that talks to Postgres through a single long-lived `psql`
// process. Used where the `pg` package is not installed (and by the test suite).
// Same SQL, same row shape as the production adapter in pg.ts.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DbError, type Db, type Queryable } from './db.js';

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number parameter');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return quote(v.toISOString());
  if (Array.isArray(v)) {
    const items = v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'));
    return quote('{' + items.join(',') + '}');
  }
  if (typeof v === 'object') return quote(JSON.stringify(v));
  return quote(String(v));
}
function quote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function inlineParams(text: string, params: unknown[] = []): string {
  return text.replace(/\$(\d+)/g, (_, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`Missing parameter $${n}`);
    return literal(params[i]);
  });
}

function normalize(v: unknown): unknown {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/.test(v)) return new Date(v).toISOString();
  return v;
}

const END = '@@END@@';

export function createPsqlDb(connectionString: string, psqlPath = 'psql'): Db {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let buffer = '';
  let waiting: ((lines: string[]) => void) | undefined;
  let lines: string[] = [];

  function ensure() {
    if (proc) return proc;
    proc = spawn(psqlPath, [connectionString, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0'], { stdio: 'pipe' });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line === END) {
          const done = waiting;
          const out = lines;
          waiting = undefined;
          lines = [];
          done?.(out);
        } else lines.push(line);
      }
    });
    proc.stderr.on('data', () => undefined); // errors are reported through LAST_ERROR_* below
    proc.stdin.write("SET TIME ZONE 'UTC';\n");
    return proc;
  }

  function send(script: string): Promise<string[]> {
    const p = ensure();
    return new Promise((resolve) => {
      waiting = resolve;
      p.stdin.write(script + `\n\\echo ${END}\n`);
    });
  }

  async function exec(sqlLine: string): Promise<string[]> {
    const script = `\\unset LAST_ERROR_SQLSTATE\n${sqlLine}\n\\if :ERROR\n\\echo @@ERR@@ :LAST_ERROR_SQLSTATE :LAST_ERROR_MESSAGE\n\\else\n\\echo @@OK@@\n\\endif`;
    const out = await send(script);
    const err = out.find((l) => l.startsWith('@@ERR@@'));
    if (err) {
      const [, code = '', ...msg] = err.split(' ');
      throw new DbError(msg.join(' '), code);
    }
    return out;
  }

  async function raw<R>(text: string, params?: unknown[]): Promise<R[]> {
    const body = text.trim().replace(/;\s*$/, '');
    // Parameters are inlined below, which hides type errors that node-postgres would hit
    // (it sends parameters untyped). PREPARE first so Postgres infers parameter types the same way.
    if (params && params.length && /\$\d/.test(body)) {
      await exec(`PREPARE _typecheck AS ${body};`);
      await exec('DEALLOCATE _typecheck;');
    }
    const sql = inlineParams(body, params);
    let wrapped: string;
    if (/^(select|with)\b/i.test(sql)) wrapped = `SELECT coalesce(json_agg(row_to_json(_q)), '[]'::json) FROM (${sql}) _q;`;
    else if (/\breturning\b/i.test(sql)) wrapped = `WITH _q AS (${sql}) SELECT coalesce(json_agg(row_to_json(_q)), '[]'::json) FROM _q;`;
    else wrapped = `${sql};`;
    const script = `\\unset LAST_ERROR_SQLSTATE\n${wrapped}\n\\if :ERROR\n\\echo @@ERR@@ :LAST_ERROR_SQLSTATE :LAST_ERROR_MESSAGE\n\\else\n\\echo @@OK@@\n\\endif`;
    const out = await send(script);
    const err = out.find((l) => l.startsWith('@@ERR@@'));
    if (err) {
      const [, code = '', ...msg] = err.split(' ');
      throw new DbError(msg.join(' '), code);
    }
    const json = out.find((l) => l.startsWith('['));
    if (!json) return [];
    const rows = JSON.parse(json) as Record<string, unknown>[];
    return rows.map((r) => {
      for (const k of Object.keys(r)) r[k] = normalize(r[k]);
      return r as R;
    });
  }

  // single connection: serialize everything; a transaction holds the lock throughout
  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    query: <R>(text: string, params?: unknown[]) => locked(() => raw<R>(text, params)),
    tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return locked(async () => {
        await raw('BEGIN');
        try {
          const out = await fn({ query: raw });
          await raw('COMMIT');
          return out;
        } catch (e) {
          await raw('ROLLBACK').catch(() => undefined);
          throw e;
        }
      });
    },
    async close() {
      if (!proc) return;
      const p = proc;
      proc = undefined;
      await new Promise<void>((resolve) => {
        p.once('exit', () => resolve());
        p.stdin.end('\\q\n');
      });
    },
  };
}

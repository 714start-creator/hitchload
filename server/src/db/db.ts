// Minimal database interface. Rows come back as plain objects with
// timestamps as ISO-8601 strings, bigint as number, date as 'YYYY-MM-DD'.

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<R>(q: Queryable, text: string, params?: unknown[]): Promise<R> {
  const rows = await q.query<R>(text, params);
  if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
  return rows[0] as R;
}

export async function maybeOne<R>(q: Queryable, text: string, params?: unknown[]): Promise<R | undefined> {
  const rows = await q.query<R>(text, params);
  return rows[0];
}

/** Postgres error codes we react to. */
export const PgCode = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
} as const;

export class DbError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function isPgCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

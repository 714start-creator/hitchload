import type { Db } from './db.js';

/** Uses node-postgres when installed (production), otherwise a psql-backed adapter. */
export async function createDb(url: string): Promise<Db> {
  if (process.env.DB_DRIVER !== 'psql') {
    try {
      const mod = await import('./pg.js');
      return mod.createPgDb(url);
    } catch (e) {
      if (process.env.DB_DRIVER === 'pg') throw e;
    }
  }
  const { createPsqlDb } = await import('./psql.js');
  return createPsqlDb(url);
}
export * from './db.js';

import { createApp, createContext } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startWorkers } from './services/workers.js';

const cfg = loadConfig();
const db = await createDb(cfg.databaseUrl);
await migrate(db);
// demo data for a test server (SEED_DEMO=1); refuses to run in production
if (process.env.SEED_DEMO === '1' && !cfg.prod) await import('./db/seed.js');
const ctx = createContext(cfg, db);
const server = createApp(ctx);
const stopWorkers = startWorkers(ctx);

server.listen(cfg.port, () => {
  ctx.log(`Hitchload API on :${cfg.port} (payments=${ctx.payments.kind}, sms=${ctx.sms.kind}, push=${ctx.push.kind}, storage=${ctx.storage.kind})`);
});

async function shutdown() {
  ctx.log('shutting down');
  stopWorkers();
  ctx.hub.close();
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

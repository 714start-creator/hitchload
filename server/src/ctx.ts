import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { Hub } from './http/realtime.js';
import type { Email } from './providers/email.js';
import type { Payments } from './providers/payments.js';
import type { Push } from './providers/push.js';
import type { Sms } from './providers/sms.js';
import type { Storage } from './providers/storage.js';
import type { WebPush } from './providers/webpush.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  payments: Payments;
  sms: Sms;
  push: Push;
  storage: Storage;
  email: Email;
  webPush: WebPush;
  hub: Hub;
  now: () => Date;
  log: (msg: string, extra?: unknown) => void;
  /** Time zone for quiet hours and SMS wording. */
  timeZone: string;
}

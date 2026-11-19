// Phone verification and transactional SMS: Twilio Verify + Messaging,
// or a local stand-in that stores hashed codes in the database.
import type { Db } from '../db/db.js';
import { digits, sha256 } from '../lib/crypto.js';

export interface Sms {
  readonly kind: 'twilio' | 'local';
  /** Sends a code. The local stand-in returns it so dev builds can show it. */
  start(phone: string): Promise<{ devCode?: string }>;
  check(phone: string, code: string): Promise<boolean>;
  send(phone: string, text: string): Promise<void>;
}

export function createTwilioSms(cfg: { accountSid: string; authToken: string; verifyServiceSid: string; fromNumber?: string }): Sms {
  const auth = 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  async function post(url: string, params: Record<string, string>) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${json?.message ?? 'error'}`);
    return json;
  }
  return {
    kind: 'twilio',
    async start(phone) {
      await post(`https://verify.twilio.com/v2/Services/${cfg.verifyServiceSid}/Verifications`, { To: phone, Channel: 'sms' });
      return {};
    },
    async check(phone, code) {
      try {
        const r = await post(`https://verify.twilio.com/v2/Services/${cfg.verifyServiceSid}/VerificationCheck`, { To: phone, Code: code });
        return r.status === 'approved';
      } catch {
        return false; // expired / too many attempts
      }
    },
    async send(phone, text) {
      if (!cfg.fromNumber) return;
      await post(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, { To: phone, From: cfg.fromNumber, Body: text });
    },
  };
}

export function createLocalSms(db: Db, opts: { exposeCode: boolean; log?: (m: string) => void; sent?: { phone: string; text: string }[] }): Sms {
  const log = opts.log ?? ((m: string) => console.log(m));
  return {
    kind: 'local',
    async start(phone) {
      const code = digits(6);
      await db.query(
        `INSERT INTO otp_codes(phone, code_hash, expires_at, attempts) VALUES ($1, $2, now() + interval '10 minutes', 0)
         ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
        [phone, sha256(phone + code)],
      );
      log(`[sms] code for ${phone}: ${code}`);
      return opts.exposeCode ? { devCode: code } : {};
    },
    async check(phone, code) {
      const rows = await db.query<{ code_hash: string; attempts: number; expired: boolean }>(
        `UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1 RETURNING code_hash, attempts, expires_at < now() AS expired`,
        [phone],
      );
      const r = rows[0];
      if (!r || r.expired || r.attempts > 5) return false;
      if (r.code_hash !== sha256(phone + code)) return false;
      await db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
      return true;
    },
    async send(phone, text) {
      opts.sent?.push({ phone, text });
      log(`[sms] to ${phone}: ${text}`);
    },
  };
}

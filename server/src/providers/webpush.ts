// Browser push notifications (Web Push): message encryption per RFC 8291
// (aes128gcm) and VAPID authentication per RFC 8292. No external library.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPush {
  readonly kind: 'vapid' | 'log';
  readonly publicKey: string | null;
  /** Returns 'gone' when the browser unsubscribed (the stored subscription should be deleted). */
  send(sub: WebPushSubscription, payload: object): Promise<'ok' | 'gone'>;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** RFC 8291 §3–4. `salt` and `asKeys` are only passed by tests. */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, o: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  const ecdh = createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = o.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** VAPID "Authorization" header value for one push service origin. */
export function vapidAuth(audience: string, subject: string, publicKey: string, privateKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const pub = fromB64u(publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

export function isValidSubscription(s: unknown): s is WebPushSubscription {
  const x = s as WebPushSubscription;
  if (!x || typeof x.endpoint !== 'string' || !x.keys || typeof x.keys.p256dh !== 'string' || typeof x.keys.auth !== 'string') return false;
  try {
    const u = new URL(x.endpoint);
    if (u.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return fromB64u(x.keys.p256dh).length === 65 && fromB64u(x.keys.auth).length === 16;
}

export function createVapidPush(publicKey: string, privateKey: string, subject: string): WebPush {
  return {
    kind: 'vapid',
    publicKey,
    async send(sub, payload) {
      const body = encryptPayload(Buffer.from(JSON.stringify(payload)), fromB64u(sub.keys.p256dh), fromB64u(sub.keys.auth));
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuth(new URL(sub.endpoint).origin, subject, publicKey, privateKey),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'high',
        },
        body,
      });
      if (res.status === 404 || res.status === 410) return 'gone';
      if (!res.ok) throw new Error(`web push ${res.status}: ${await res.text()}`);
      return 'ok';
    },
  };
}

export function createLogWebPush(sent: { sub: WebPushSubscription; payload: object }[] = []): WebPush {
  return {
    kind: 'log',
    publicKey: null,
    async send(sub, payload) {
      sent.push({ sub, payload });
      return 'ok';
    },
  };
}

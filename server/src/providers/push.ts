// Push notifications through the Expo push service (delivers to APNs and FCM).

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android channel: "orders" is high priority, "account" default */
  channelId?: 'orders' | 'account' | 'chat';
}

export interface Push {
  readonly kind: 'expo' | 'log';
  /** Returns tokens that are no longer valid and should be deleted. */
  send(messages: PushMessage[]): Promise<{ invalidTokens: string[] }>;
}

export function createExpoPush(accessToken?: string): Push {
  return {
    kind: 'expo',
    async send(messages) {
      const invalidTokens: string[] = [];
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100).map((m) => ({ sound: 'default', priority: 'high', ...m }));
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        try {
          const res = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers, body: JSON.stringify(chunk) });
          const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
          json.data?.forEach((t, j) => {
            if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') invalidTokens.push(chunk[j]!.to);
          });
        } catch (e) {
          console.error('push send failed', e);
        }
      }
      return { invalidTokens };
    },
  };
}

export function createLogPush(sink?: PushMessage[]): Push {
  return {
    kind: 'log',
    async send(messages) {
      for (const m of messages) {
        sink?.push(m);
        if (!sink) console.log(`[push] ${m.to}: ${m.title} — ${m.body}`);
      }
      return { invalidTokens: [] };
    },
  };
}

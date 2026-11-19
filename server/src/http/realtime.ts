// Live updates over WebSocket: GET /v1/ws?token=... ; server pushes {type, data}.
// Single-instance hub; for several server instances, put Redis pub/sub behind publish().
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

export interface Hub {
  publish(userId: string, type: string, data: unknown): void;
  online(userId: string): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createHub(authenticate: (token: string) => Promise<{ id: string } | null>): Hub {
  const wss = new WebSocketServer({ noServer: true });
  const byUser = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();

  const timer = setInterval(() => {
    for (const set of byUser.values())
      for (const ws of set) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
  }, 30_000);
  timer.unref();

  return {
    publish(userId, type, data) {
      const set = byUser.get(userId);
      if (!set) return;
      const msg = JSON.stringify({ type, data });
      for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    },
    online: (userId) => (byUser.get(userId)?.size ?? 0) > 0,
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      authenticate(token)
        .then((user) => {
          if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            let set = byUser.get(user.id);
            if (!set) byUser.set(user.id, (set = new Set()));
            set.add(ws);
            alive.set(ws, true);
            ws.on('pong', () => alive.set(ws, true));
            ws.on('close', () => {
              set!.delete(ws);
              if (set!.size === 0) byUser.delete(user.id);
            });
            ws.on('error', () => undefined);
            ws.send(JSON.stringify({ type: 'hello', data: { userId: user.id } }));
          });
        })
        .catch(() => socket.destroy());
    },
    close() {
      clearInterval(timer);
      for (const set of byUser.values()) for (const ws of set) ws.terminate();
      wss.close();
    },
  };
}

/** Hub stand-in for tests: records events. */
export function createMemoryHub(events: { userId: string; type: string; data: unknown }[] = []): Hub & { events: typeof events } {
  return {
    events,
    publish: (userId, type, data) => void events.push({ userId, type, data }),
    online: () => false,
    handleUpgrade: (_r, socket) => socket.destroy(),
    close: () => undefined,
  };
}

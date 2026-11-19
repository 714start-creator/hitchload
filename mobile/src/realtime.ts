// Live updates: WebSocket to /v1/ws with automatic reconnect.
export interface LiveEvent {
  type: 'hello' | 'order' | 'message' | 'notification' | 'driver_position' | string;
  data: any;
}

export function connectLive(apiUrl: string, token: string, onEvent: (e: LiveEvent) => void): () => void {
  const url = apiUrl.replace(/^http/, 'ws') + `/v1/ws?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 1000;
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as LiveEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

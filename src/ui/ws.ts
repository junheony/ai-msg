import type { ClientMessage, ServerMessage } from '../shared/protocol';

export function createSocket(onMessage: (m: ServerMessage) => void, onStatus: (connected: boolean) => void): { send(m: ClientMessage): void; close(): void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 1000; onStatus(true); };
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(String(ev.data)) as ServerMessage); } catch { /* ignore */ } };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) { setTimeout(open, delay); delay = Math.min(delay * 2, 10_000); }
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(m) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
    close() { closed = true; ws?.close(); },
  };
}

import { HEARTBEAT_TIMEOUT_MS, type ClientMessage, type ServerMessage } from '../shared/protocol';

/** Server message kinds beyond the base set this UI handles: told with every open_session (docs/protocol.md rule 3). */
const ACCEPTS = ['sandbox', 'turn_queued'];

/**
 * Review M10: a browser cannot see the HTTP status of a refused upgrade, so after every close
 * the session is checked with /api/me; a 401 hands back to the login screen instead of
 * looping on "재연결 중…".
 */
export function createSocket(
  onMessage: (m: ServerMessage) => void,
  onStatus: (connected: boolean) => void,
  onUnauthed: () => void = () => {},
  /** `heartbeat`: asked right after each hello — true (the server has the 'heartbeat' feature) subscribes and arms a watchdog that drops a socket silent for `timeoutMs` (default HEARTBEAT_TIMEOUT_MS). An older server: no watch. */
  opts: { heartbeat?: () => boolean; timeoutMs?: number } = {},
): { /** `false`: not connected, nothing sent. */ send(m: ClientMessage): boolean; /** Drops the current socket (it stopped answering) and connects anew, without waiting for its close. */ reconnect(): void; /** The page is back in view or the network is back: skips the reconnect wait (or the check before it) and connects now; nothing when connected or connecting. */ wake(): void; /** The user asked (다시 시도): like wake(), but a socket stuck in CONNECTING is dropped for a fresh one instead of being waited on. */ retry(): void; close(): void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  /** The reconnect wait, while one runs. */
  let pending: ReturnType<typeof setTimeout> | undefined;
  /** The close handler's /api/me check is out (no wait is running yet). */
  let checking = false;
  /** wake() came during that check: connect as soon as it answers, without waiting. */
  let wakeRequested = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  /** The heartbeat watchdog, while this socket's server beats: reset by every message, reconnects when it runs out. */
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let beating = false;
  const stopWatch = () => { beating = false; if (watchdog !== undefined) { clearTimeout(watchdog); watchdog = undefined; } };
  const arm = () => {
    if (!beating) return;
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => { watchdog = undefined; reconnect(); }, opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS);
  };

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { delay = 1000; onStatus(true); };
    const self = ws;
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      arm();
      // The beat only keeps the watchdog quiet: nothing else to do with it.
      if (m.type === 'heartbeat') return;
      try { onMessage(m); } catch { /* ignore */ }
      // onMessage set the hello's features: subscribe (rule 3 — the server beats only for a socket that asked) and start watching.
      if (m.type === 'hello' && ws === self && self.readyState === WebSocket.OPEN && opts.heartbeat?.()) {
        self.send(JSON.stringify({ type: 'heartbeat' } satisfies ClientMessage));
        beating = true;
        arm();
      }
    };
    ws.onclose = () => {
      stopWatch();
      onStatus(false);
      if (closed) return;
      checking = true;
      void fetch('/api/me', { credentials: 'same-origin' })
        .then((r) => r.status === 401, () => false)
        .then((unauthed) => {
          checking = false;
          const woken = wakeRequested;
          wakeRequested = false;
          if (closed) return;
          if (unauthed) { closed = true; onUnauthed(); return; }
          if (woken) { delay = 1000; open(); return; }
          pending = setTimeout(() => { pending = undefined; open(); }, delay);
          delay = Math.min(delay * 2, 10_000);
        });
    };
    ws.onerror = () => ws?.close();
  };
  open();

  const clearWait = () => { if (pending !== undefined) { clearTimeout(pending); pending = undefined; } };
  const reconnect = () => {
    if (closed || !ws) return;
    const old = ws;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    stopWatch();
    old.close();
    // A wait set by the old socket's close must not open a second socket next to this one.
    clearWait();
    delay = 1000;
    onStatus(false);
    open();
  };
  const wake = () => {
    if (closed) return;
    // A phone back from the background must not sit out a wait of up to 10 s that was set while it slept.
    if (pending !== undefined) { clearWait(); delay = 1000; open(); }
    else if (checking) wakeRequested = true;
  };

  return {
    send(m) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m.type === 'open_session' ? { ...m, accepts: ACCEPTS } : m));
      return true;
    },
    reconnect,
    wake,
    retry() {
      if (closed) return;
      if (pending !== undefined || checking) { wake(); return; }
      reconnect();
    },
    close() { closed = true; clearWait(); stopWatch(); ws?.close(); },
  };
}

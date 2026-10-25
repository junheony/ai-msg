import { COOKIE_NAME, cookieValueFor } from '../auth';

/** The Mac's own server as the relay bridge reaches it: 127.0.0.1 and the login token (read when needed). */
export type LoopbackTarget = { port: number; token: () => string };

/** What the bridge's loopback requests carry so the server takes them as its own UI's. Never sent to the phone. */
export function loopbackHeaders(t: LoopbackTarget): Record<string, string> {
  return { cookie: `${COOKIE_NAME}=${cookieValueFor(t.token())}`, origin: `http://127.0.0.1:${t.port}`, host: `127.0.0.1:${t.port}` };
}

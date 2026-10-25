/** Where the local cloud client talks to: the app origin (accounts, host API) and the relay origin (host WebSocket). */
export type CloudConfig = { enabled: boolean; baseUrl: string; relayUrl: string };

const DEFAULT_APP = 'https://app.aimsg.app';
const DEFAULT_RELAY = 'https://relay.aimsg.app';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The origin of `raw` when it is https, or http on a loopback host; else `null`. */
function originOf(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return u.origin;
  return null;
}

/**
 * `DECK_CLOUD=off` turns the cloud off. `DECK_CLOUD_URL` (app) and `DECK_RELAY_URL` (relay) must be https — http only
 * for a loopback host — and must be two different origins; otherwise the cloud is off and one line is logged (the
 * variable's name only: the address may carry credentials). A disabled config carries no address.
 */
export function cloudConfig(env: NodeJS.ProcessEnv, log: (s: string) => void = (s) => console.error(s)): CloudConfig {
  const appRaw = env.DECK_CLOUD_URL || DEFAULT_APP;
  const relayRaw = env.DECK_RELAY_URL || DEFAULT_RELAY;
  const off = { enabled: false, baseUrl: '', relayUrl: '' };
  if (env.DECK_CLOUD?.toLowerCase() === 'off') return off;
  const baseUrl = originOf(appRaw);
  const relayUrl = originOf(relayRaw);
  if (!baseUrl || !relayUrl) {
    log(`deck: cloud off — ${!baseUrl ? 'DECK_CLOUD_URL' : 'DECK_RELAY_URL'} must be an https address (http only for localhost)`);
    return off;
  }
  if (baseUrl === relayUrl) {
    log('deck: cloud off — DECK_CLOUD_URL and DECK_RELAY_URL must be different origins');
    return off;
  }
  return { enabled: true, baseUrl, relayUrl };
}

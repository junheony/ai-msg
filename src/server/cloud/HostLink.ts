import type { LinkStartRes } from '../../shared/cloud/api-types';
import { toB64u } from '../../shared/cloud/b64';
import { importStaticPrivate } from '../../shared/cloud/noise';
import { CloudError, type CloudApi } from './CloudApi';
import type { CloudState } from './CloudState';

export type LinkResult = 'linked' | 'expired' | 'cancelled';
export type HostLinkHandle = { info: LinkStartRes; done: Promise<LinkResult>; cancel(): void };

const SLOW_DOWN_STEP_MS = 2000;

/**
 * Device-code linking (cloud/src/hosts.ts): `POST /v1/host/link/start` with this Mac's X25519 public key, then poll
 * every `interval` s until the user approves in the browser. 429 `slow_down` adds 2 s to the interval; 410/404 or the
 * code's lifetime running out → `expired`; other failures (network, 5xx) just try again next interval. Linked → the
 * host id, token and email go to the state file.
 */
export async function startLink(o: {
  api: Pick<CloudApi, 'linkStart' | 'linkPoll'>;
  state: CloudState;
  hostName: string;
  uiVersion: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<HostLinkHandle> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hostPub = toB64u((await importStaticPrivate(o.state.get().hostKey)).publicRaw);
  const info = await o.api.linkStart({ hostName: o.hostName, hostPub, uiVersion: o.uiVersion });

  let cancelled = false;
  let onCancel = () => {};
  const cancelSignal = new Promise<void>((r) => { onCancel = r; });

  const done = (async (): Promise<LinkResult> => {
    const deadline = now() + info.expiresIn * 1000;
    let interval = info.interval * 1000;
    for (;;) {
      await Promise.race([sleep(interval), cancelSignal]);
      if (cancelled) return 'cancelled';
      if (now() >= deadline) return 'expired';
      let res;
      try {
        res = await o.api.linkPoll(info.deviceCode);
      } catch (e) {
        if (e instanceof CloudError && e.status === 429 && e.code === 'slow_down') interval += SLOW_DOWN_STEP_MS;
        else if (e instanceof CloudError && (e.status === 410 || e.status === 404)) return 'expired';
        continue;
      }
      if (res.state === 'linked') {
        // The token is handed out once: keep it even if cancel() raced with this poll.
        await o.state.update({ hostId: res.hostId, hostToken: res.hostToken, email: res.email });
        return 'linked';
      }
      if (cancelled) return 'cancelled';
    }
  })();

  return { info, done, cancel: () => { cancelled = true; onCancel(); } };
}

import type { WebSocket } from 'ws';
import type { CloudLinkView, CloudStatus } from '../../shared/cloud/api-types';
import { CloudApi, CloudError } from './CloudApi';
import type { CloudConfig } from './config';
import { CloudState } from './CloudState';
import { startLink, type HostLinkHandle } from './HostLink';
import { RelayBridge } from './RelayBridge';
import { RelayClient, type RelayState } from './RelayClient';
import type { RelayWsContext } from './wsPolicy';

export class CloudServiceError extends Error {
  override name = 'CloudServiceError';
  constructor(readonly code: 'disabled' | 'already_linked' | 'unreachable') {
    super(code);
  }
}

const RECHECK_MS = 30_000;
/** After an upgrade 401 the API did not confirm (it still takes the token, or did not answer): try the relay again. */
const UNCONFIRMED_401_RETRY_MS = 60_000;

/**
 * The Mac's cloud client: the link (device-code flow), the relay socket and the Noise bridge to paired phones.
 *
 * - `start()` after listen: it never throws and never blocks startup; failures go to the status and one log line
 *   (state names only — never the cloud's address or a token).
 * - Not linked → no request to the cloud at all, and nothing written.
 * - An upgrade 401 alone does not forget the link (a proxy could answer it): the host API must also refuse the token.
 */
export class CloudService {
  private readonly api: CloudApi;
  private state: CloudState | null = null;
  private loading: Promise<CloudState | null> | null = null;
  private client: RelayClient | null = null;
  private bridge: RelayBridge | null = null;
  private relay: CloudStatus['relay'] = 'off';
  private link: { handle: HostLinkHandle; view: CloudLinkView } | null = null;
  private linking: Promise<CloudLinkView> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRecheck = 0;
  private stopped = false;
  private readonly listeners = new Set<(s: CloudStatus) => void>();

  constructor(private readonly o: {
    cfg: CloudConfig;
    configDir: string;
    port: number;
    token: () => string;
    hostVersion: string;
    hostName: string;
    log: (s: string) => void;
    fetch?: typeof fetch;
    WebSocketImpl?: typeof WebSocket;
    /** The Mac's current settings, for the relay's socket policy. */
    settings?: () => RelayWsContext;
  }) {
    this.api = new CloudApi({ baseUrl: o.cfg.baseUrl, fetch: o.fetch });
  }

  start(): void {
    if (!this.o.cfg.enabled) return;
    this.stopped = false;
    void this.load().then((st) => { if (st && !this.stopped && st.get().hostToken) this.startRelay(); });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.link?.handle.cancel();
    this.link = null;
    this.stopRelay();
  }

  status(): CloudStatus {
    const d = this.state?.get();
    return {
      enabled: this.o.cfg.enabled,
      linked: !!d?.hostToken,
      email: d?.hostToken ? d.email : null,
      relay: this.relay,
      link: this.link?.view ?? null,
      devices: (d?.devices ?? []).map((x) => ({ id: x.id, name: x.name, addedAt: x.addedAt })),
      plan: d?.hostToken ? d.plan : null,
    };
  }

  onChange(cb: (s: CloudStatus) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Asks the relay to recompute the entitlement (after a payment) — at most once per 30 s. */
  recheck(): void {
    const now = Date.now();
    if (now - this.lastRecheck < RECHECK_MS) return;
    this.lastRecheck = now;
    this.client?.recheck();
  }

  /** Starts (or returns the running) device-code link; the device code itself never leaves this class. */
  startLink(): Promise<CloudLinkView> {
    if (!this.o.cfg.enabled) return Promise.reject(new CloudServiceError('disabled'));
    if (this.link) return Promise.resolve(this.link.view);
    this.linking ??= (async () => {
      const st = await this.load();
      if (!st) throw new CloudServiceError('unreachable');
      if (st.get().hostToken) throw new CloudServiceError('already_linked');
      let handle: HostLinkHandle;
      try {
        handle = await startLink({ api: this.api, state: st, hostName: this.o.hostName, uiVersion: this.o.hostVersion });
      } catch (err) {
        this.o.log(`deck: cloud — could not start linking (${errName(err)})`);
        throw new CloudServiceError('unreachable');
      }
      const view = { userCode: handle.info.userCode, verifyUrl: handle.info.verifyUrl, expiresAt: Date.now() + handle.info.expiresIn * 1000 };
      const link = { handle, view };
      this.link = link;
      void handle.done.then(
        (r) => {
          if (this.link === link) this.link = null;
          if (r === 'linked' && !this.stopped) this.startRelay();
          this.changed();
        },
        (err: unknown) => {
          if (this.link === link) this.link = null;
          this.o.log(`deck: cloud — linking failed (${errName(err)})`);
          this.changed();
        },
      );
      this.changed();
      return view;
    })().finally(() => { this.linking = null; });
    return this.linking;
  }

  /** Tells the cloud (best effort) and forgets the link here either way; the host key stays. */
  async unlink(): Promise<void> {
    if (!this.o.cfg.enabled) throw new CloudServiceError('disabled');
    const st = await this.load();
    this.link?.handle.cancel();
    this.link = null;
    const token = st?.get().hostToken;
    if (!st || !token) return;
    this.stopRelay();
    try {
      await this.api.unlink(token);
    } catch (err) {
      this.o.log(`deck: cloud — the cloud did not take the unlink, forgetting the link here anyway (${errName(err)})`);
    }
    await st.reset();
    this.changed();
  }

  /**
   * Drops the device's channel first (synchronously — nothing it sends after this is handled), then removes it from
   * the trusted list and queues the cloud revoke, which is retried on the next relay connection when it fails.
   */
  async revokeDevice(id: string): Promise<void> {
    if (!this.o.cfg.enabled) throw new CloudServiceError('disabled');
    this.bridge?.dropDevice(id, 'revoked');
    const st = await this.load();
    if (!st) return;
    const d = st.get();
    if (!d.hostToken) return;
    const write = st.update({
      devices: d.devices.filter((x) => x.id !== id),
      pendingRevokes: d.pendingRevokes.includes(id) ? d.pendingRevokes : [...d.pendingRevokes, id],
    });
    this.changed();
    await write;
    await this.flushRevokes();
  }

  private load(): Promise<CloudState | null> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= CloudState.load(this.o.configDir).then(
      (st) => { this.state = st; return st; },
      (err: unknown) => {
        this.loading = null;
        this.o.log(`deck: cloud — could not read the cloud state (${errName(err)})`);
        return null;
      },
    );
    return this.loading;
  }

  private changed(): void {
    const s = this.status();
    for (const cb of this.listeners) {
      try { cb(s); } catch { /* a listener's problem */ }
    }
  }

  private setRelay(r: CloudStatus['relay']): void {
    if (this.relay === r) return;
    this.relay = r;
    this.changed();
  }

  private relayUrl(): string {
    const u = new URL('/relay/host', this.o.cfg.relayUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  private startRelay(): void {
    const st = this.state;
    if (!st || this.client) return;
    this.clearRetry();
    const client = new RelayClient({ url: this.relayUrl(), token: () => st.get().hostToken, WebSocketImpl: this.o.WebSocketImpl });
    const bridge = new RelayBridge({
      relay: client,
      state: st,
      loopback: { port: this.o.port, token: this.o.token },
      hostVersion: this.o.hostVersion,
      log: this.o.log,
      onDevicesChanged: () => this.changed(),
      settings: this.o.settings,
    });
    this.client = client;
    this.bridge = bridge;
    client.on('state', (s: RelayState) => {
      if (this.client !== client) return;
      if (s !== 'up') bridge.dropAll();
      if (s === 'unlinked') { void this.confirmUnlinked(); return; }
      this.setRelay(s);
      if (s === 'up') {
        void this.flushRevokes().then(() => this.syncDevices()).catch((err: unknown) => {
          this.o.log(`deck: cloud — could not write the cloud state (${errName(err)})`);
        });
      }
    });
    client.start();
  }

  private stopRelay(): void {
    this.clearRetry();
    const client = this.client;
    const bridge = this.bridge;
    this.client = null;
    this.bridge = null;
    client?.stop();
    bridge?.close();
    this.setRelay('off');
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Review item 1: the relay refused the token. Forget the link only when the host API refuses it too. */
  private async confirmUnlinked(): Promise<void> {
    const st = this.state;
    const token = st?.get().hostToken;
    this.stopRelay();
    if (!st || !token || this.stopped) return;
    this.setRelay('down');
    try {
      await this.api.devices(token);
    } catch (err) {
      if (err instanceof CloudError && err.status === 401) {
        if (st.get().hostToken !== token) return;
        this.o.log('deck: cloud — the cloud no longer accepts this Mac, link forgotten');
        await this.forget(st);
        return;
      }
    }
    if (this.stopped || st.get().hostToken !== token) return;
    this.o.log('deck: cloud — relay refused the link but the cloud still accepts it, retrying later');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && st.get().hostToken === token) this.startRelay();
    }, UNCONFIRMED_401_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private async forget(st: CloudState): Promise<void> {
    this.stopRelay();
    try {
      await st.reset();
    } catch (err) {
      this.o.log(`deck: cloud — could not write the cloud state (${errName(err)})`);
    }
    this.changed();
  }

  /** Cloud revokes that failed before; each is dropped from the queue once the cloud took it (or never knew it). */
  private async flushRevokes(): Promise<void> {
    const st = this.state;
    const token = st?.get().hostToken;
    if (!st || !token) return;
    for (const id of st.get().pendingRevokes) {
      try {
        await this.api.revokeDevice(token, id);
      } catch (err) {
        if (!(err instanceof CloudError && err.status === 404)) {
          this.o.log(`deck: cloud — device revoke not taken yet, will retry (${errName(err)})`);
          continue;
        }
      }
      if (st.get().hostToken !== token) return;
      await st.update({ pendingRevokes: st.get().pendingRevokes.filter((x) => x !== id) });
    }
  }

  /** Devices the cloud no longer lists (revoked elsewhere while this Mac was away) are dropped here too. */
  private async syncDevices(): Promise<void> {
    const st = this.state;
    const token = st?.get().hostToken;
    if (!st || !token) return;
    let active: Set<string>;
    try {
      active = new Set((await this.api.devices(token)).map((d) => d.id));
    } catch (err) {
      this.o.log(`deck: cloud — could not list devices (${errName(err)})`);
      return;
    }
    if (st.get().hostToken !== token) return;
    const gone = st.get().devices.filter((d) => !active.has(d.id));
    if (gone.length === 0) return;
    for (const d of gone) this.bridge?.dropDevice(d.id, 'revoked');
    const write = st.update({ devices: st.get().devices.filter((d) => active.has(d.id)) });
    this.changed();
    await write;
  }
}

/** An error's class name (and a cloud error's code) only: messages may carry addresses. */
function errName(err: unknown): string {
  if (err instanceof CloudError) return `${err.status}${err.code ? ` ${err.code}` : ''}`;
  return err instanceof Error ? err.name : typeof err;
}

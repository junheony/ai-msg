import type {
  ApiError, DeviceInfo, EntitlementRes, LinkPollRes, LinkStartReq, LinkStartRes, PairStartRes, PairStatusRes,
} from '../../shared/cloud/api-types';
import { toEntitlement } from './entitlement';

/** A cloud call that did not succeed: the HTTP status (0 = no answer: network or timeout) and the API's `code`. */
export class CloudError extends Error {
  override name = 'CloudError';
  constructor(readonly status: number, readonly code?: string) {
    super(code ? `cloud ${status} ${code}` : `cloud ${status}`);
  }
}

type Req = { method: 'GET' | 'POST'; path: string; token?: string; body?: unknown };

const MAX_RESPONSE = 1 << 20;
const clamp = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 512;

/** The app origin's host API (`/v1/host/*`, `/v1/pair/*`, `/v1/devices*`, `/v1/entitlement`). Never logs tokens. */
export class CloudApi {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.fetch = o.fetch ?? globalThis.fetch;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  /**
   * The answer is checked before anything polls on it: codes are 1–512 char strings, `verifyUrl` is on this origin,
   * `interval` is clamped to 1–60 s (missing → 5) and `expiresIn` to 1–1800 s (missing → 600).
   */
  async linkStart(req: LinkStartReq): Promise<LinkStartRes> {
    const { status, body } = await this.call({ method: 'POST', path: '/v1/host/link/start', body: req });
    const b = body as Partial<Record<keyof LinkStartRes, unknown>>;
    if (!isId(b.deviceCode) || !isId(b.userCode) || !isId(b.verifyUrl) || !this.onOrigin(b.verifyUrl)) throw new CloudError(status, 'bad_response');
    return { deviceCode: b.deviceCode, userCode: b.userCode, verifyUrl: b.verifyUrl, interval: clamp(b.interval, 1, 60, 5), expiresIn: clamp(b.expiresIn, 1, 1800, 600) };
  }

  /** 202 → `{state:'pending'}`, 200 → linked. 429 `slow_down`, 410 `expired` and the rest throw `CloudError`. */
  async linkPoll(deviceCode: string): Promise<LinkPollRes> {
    const { status, body } = await this.call({ method: 'POST', path: '/v1/host/link/poll', body: { deviceCode } });
    const b = body as { state?: unknown; hostId?: unknown; hostToken?: unknown; email?: unknown };
    if (b.state !== 'linked') return { state: 'pending' };
    if (!isId(b.hostId) || !isId(b.hostToken)) throw new CloudError(status, 'bad_response');
    return { state: 'linked', hostId: b.hostId, hostToken: b.hostToken, email: typeof b.email === 'string' ? b.email.slice(0, 320) : '' };
  }

  async unlink(token: string): Promise<void> {
    await this.json({ method: 'POST', path: '/v1/host/unlink', token });
  }

  pairStart(token: string, claimHash: string): Promise<PairStartRes> {
    return this.json({ method: 'POST', path: '/v1/pair/start', token, body: { claimHash } });
  }

  pairStatus(token: string, id: string): Promise<PairStatusRes> {
    return this.json({ method: 'GET', path: `/v1/pair/${encodeURIComponent(id)}`, token });
  }

  async pairConfirm(token: string, id: string): Promise<void> {
    await this.json({ method: 'POST', path: `/v1/pair/${encodeURIComponent(id)}/confirm`, token });
  }

  async pairReject(token: string, id: string): Promise<void> {
    await this.json({ method: 'POST', path: `/v1/pair/${encodeURIComponent(id)}/reject`, token });
  }

  devices(token: string): Promise<DeviceInfo[]> {
    return this.json({ method: 'GET', path: '/v1/devices', token });
  }

  async revokeDevice(token: string, id: string): Promise<void> {
    await this.json({ method: 'POST', path: `/v1/devices/${encodeURIComponent(id)}/revoke`, token });
  }

  /** Display only. `plan`·`st` must be known names, `untilMs` an integer ms ≥ 0 and `checkedAt` > 0 (else `bad_response`). */
  async entitlement(token: string): Promise<EntitlementRes> {
    const { status, body } = await this.call({ method: 'GET', path: '/v1/entitlement', token });
    const e = toEntitlement(body);
    if (!e) throw new CloudError(status, 'bad_response');
    return e;
  }

  private async json<T>(r: Req): Promise<T> {
    return (await this.call(r)).body as T;
  }

  private onOrigin(url: string): boolean {
    try { return new URL(url).origin === this.baseUrl; } catch { return false; }
  }

  /** Sends `r`; a 2xx must carry a JSON object or array (else `bad_response`); bodies over 1 MiB are `too_large`. */
  private async call(r: Req): Promise<{ status: number; body: object }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (r.token) headers.authorization = `Bearer ${r.token}`;
    if (r.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${r.path}`, {
        method: r.method,
        headers,
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new CloudError(0, (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const text = await readCapped(res);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* empty or not JSON */ }
    if (!res.ok) {
      const code = (body as Partial<ApiError> | null)?.code;
      throw new CloudError(res.status, typeof code === 'string' ? code : undefined);
    }
    if (body === null || typeof body !== 'object') throw new CloudError(res.status, 'bad_response');
    return { status: res.status, body };
  }
}

/** The body as text, refusing more than 1 MiB: by content-length first, then by counting while reading. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE) {
    await res.body?.cancel().catch(() => {});
    throw new CloudError(res.status, 'too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_RESPONSE) {
        await reader.cancel().catch(() => {});
        throw new CloudError(res.status, 'too_large');
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError(0, (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  return Buffer.concat(parts).toString('utf8');
}

import type {
  ApiError, DeviceInfo, EntitlementRes, LinkPollRes, LinkStartReq, LinkStartRes, PairStartRes, PairStatusRes,
} from '../../shared/cloud/api-types';

/** A cloud call that did not succeed: the HTTP status (0 = no answer: network or timeout) and the API's `code`. */
export class CloudError extends Error {
  override name = 'CloudError';
  constructor(readonly status: number, readonly code?: string) {
    super(code ? `cloud ${status} ${code}` : `cloud ${status}`);
  }
}

type Req = { method: 'GET' | 'POST'; path: string; token?: string; body?: unknown };

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

  linkStart(req: LinkStartReq): Promise<LinkStartRes> {
    return this.json({ method: 'POST', path: '/v1/host/link/start', body: req });
  }

  /** 202 → `{state:'pending'}`, 200 → linked. 429 `slow_down`, 410 `expired` and the rest throw `CloudError`. */
  linkPoll(deviceCode: string): Promise<LinkPollRes> {
    return this.json({ method: 'POST', path: '/v1/host/link/poll', body: { deviceCode } });
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

  entitlement(token: string): Promise<EntitlementRes> {
    return this.json({ method: 'GET', path: '/v1/entitlement', token });
  }

  private async json<T>(r: Req): Promise<T> {
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
    let body: unknown = null;
    try { body = await res.json(); } catch { /* empty or not JSON */ }
    if (!res.ok) {
      const code = (body as Partial<ApiError> | null)?.code;
      throw new CloudError(res.status, typeof code === 'string' ? code : undefined);
    }
    return body as T;
  }
}

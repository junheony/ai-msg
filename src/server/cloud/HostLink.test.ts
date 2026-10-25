import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LinkPollRes, LinkStartReq, LinkStartRes } from '../../shared/cloud/api-types';
import { toB64u } from '../../shared/cloud/b64';
import { importStaticPrivate } from '../../shared/cloud/noise';
import { CloudApi, CloudError } from './CloudApi';
import { CloudState } from './CloudState';
import { startLink } from './HostLink';

const INFO: LinkStartRes = { deviceCode: 'dc', userCode: 'ABCD-EFGH', verifyUrl: 'https://app.example.test/link?code=ABCD-EFGH', interval: 3, expiresIn: 600 };
type Step = LinkPollRes | CloudError;

function fakeApi(steps: Step[]) {
  const starts: LinkStartReq[] = [];
  const polls: string[] = [];
  return {
    starts, polls,
    api: {
      linkStart: async (req: LinkStartReq) => { starts.push(req); return INFO; },
      linkPoll: async (deviceCode: string) => {
        polls.push(deviceCode);
        const s = steps.shift() ?? { state: 'pending' as const };
        if (s instanceof CloudError) throw s;
        return s;
      },
    },
  };
}

async function setup(steps: Step[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-hostlink-'));
  const state = await CloudState.load(dir);
  const sleeps: number[] = [];
  let t = 0;
  const f = fakeApi(steps);
  return { dir, state, sleeps, ...f, opts: { api: f.api, state, hostName: 'Mac', uiVersion: '1.2.3', now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } } };
}

describe('startLink', () => {
  it('polls every interval, +2 s on slow_down, stores hostId/hostToken/email when linked', async () => {
    const { state, sleeps, starts, polls, opts, dir } = await setup([
      { state: 'pending' },
      new CloudError(429, 'slow_down'),
      { state: 'pending' },
      new CloudError(503),
      { state: 'linked', hostId: 'h1', hostToken: 'tok1', email: 'a@example.test' },
    ]);
    const link = await startLink(opts);
    expect(link.info).toEqual(INFO);
    expect(await link.done).toBe('linked');
    expect(sleeps).toEqual([3000, 3000, 5000, 5000, 5000]);
    expect(polls).toEqual(['dc', 'dc', 'dc', 'dc', 'dc']);
    expect(starts).toEqual([{ hostName: 'Mac', uiVersion: '1.2.3', hostPub: toB64u((await importStaticPrivate(state.get().hostKey)).publicRaw) }]);
    expect(state.get()).toMatchObject({ hostId: 'h1', hostToken: 'tok1', email: 'a@example.test' });
    expect((await CloudState.load(dir)).get().hostToken).toBe('tok1');
  });

  it('410 or the code running out → expired, nothing stored', async () => {
    const gone = await setup([{ state: 'pending' }, new CloudError(410, 'expired')]);
    expect(await (await startLink(gone.opts)).done).toBe('expired');
    expect(gone.state.get().hostToken).toBeNull();

    const late = await setup([]); // always pending: 600 s / 3 s
    expect(await (await startLink(late.opts)).done).toBe('expired');
    expect(late.polls.length).toBeLessThanOrEqual(200);
    expect(late.state.get().hostToken).toBeNull();
  });

  it('cancel() ends the wait without polling again', async () => {
    const { state, polls, opts } = await setup([]);
    let wake = () => {};
    const link = await startLink({ ...opts, sleep: () => new Promise<void>((r) => { wake = r; }) });
    link.cancel();
    expect(await link.done).toBe('cancelled');
    wake();
    await new Promise((r) => setImmediate(r));
    expect(polls).toEqual([]);
    expect(state.get().hostToken).toBeNull();
  });
});

describe('CloudApi', () => {
  const recorder = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    return { calls, api: new CloudApi({ baseUrl: 'https://app.example.test', fetch }) };
  };

  it('sends the host token as a Bearer header and JSON bodies', async () => {
    const { calls, api } = recorder(200, { pairingId: 'p1', expiresAt: 5 });
    expect(await api.pairStart('tok', 'hash')).toEqual({ pairingId: 'p1', expiresAt: 5 });
    expect(calls[0]!.url).toBe('https://app.example.test/v1/pair/start');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ claimHash: 'hash' });
  });

  it('linkPoll: 202 → pending, 200 → linked', async () => {
    expect(await recorder(202, { state: 'pending' }).api.linkPoll('dc')).toEqual({ state: 'pending' });
    const linked = { state: 'linked', hostId: 'h', hostToken: 't', email: 'e@example.test' };
    const r = recorder(200, linked);
    expect(await r.api.linkPoll('dc')).toEqual(linked);
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ deviceCode: 'dc' });
  });

  it('errors become CloudError with the status and code; ids are path-encoded', async () => {
    const r = recorder(409, { error: 'burned', code: 'burned' });
    await expect(r.api.pairConfirm('tok', 'a/b')).rejects.toMatchObject({ status: 409, code: 'burned' });
    expect(r.calls[0]!.url).toBe('https://app.example.test/v1/pair/a%2Fb/confirm');
    const down = new CloudApi({ baseUrl: 'https://app.example.test', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.devices('tok')).rejects.toBeInstanceOf(CloudError);
    await expect(down.devices('tok')).rejects.toMatchObject({ status: 0 });
  });
});

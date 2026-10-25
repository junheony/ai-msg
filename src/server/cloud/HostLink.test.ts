import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const dirs: string[] = [];
const tmpDir = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-hostlink-')); dirs.push(d); return d; };
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function setup(steps: Step[]) {
  const dir = await tmpDir();
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

describe('startLink — defaults and odd server answers', () => {
  it('cancel() clears the sleep timer', async () => {
    const { opts } = await setup([]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const link = await startLink({ api: opts.api, state: opts.state, hostName: 'Mac', uiVersion: '1.2.3' });
    expect(vi.getTimerCount()).toBe(1);
    link.cancel();
    expect(await link.done).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('{} answers do not make the poll run hot', async () => {
    const state = await CloudState.load(await tmpDir());
    const polls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/start')) return Response.json({ deviceCode: 'dc', userCode: 'U', verifyUrl: 'https://app.example.test/link?code=U' });
      polls.push(u);
      return Response.json({});
    }) as typeof globalThis.fetch;
    const api = new CloudApi({ baseUrl: 'https://app.example.test', fetch });
    const sleeps: number[] = [];
    let t = 0;
    const link = await startLink({ api, state, hostName: 'Mac', uiVersion: '1.2.3', now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    expect(link.info).toMatchObject({ interval: 5, expiresIn: 600 });
    expect(await link.done).toBe('expired');
    expect(new Set(sleeps)).toEqual(new Set([5000]));
    expect(polls.length).toBeLessThanOrEqual(120);
    expect(state.get().hostToken).toBeNull();
  });
});

describe('CloudApi', () => {
  const answer = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) =>
    new CloudApi({ baseUrl: 'https://app.example.test', fetch: (async () => new Response(body, { status, headers })) as typeof fetch });
  const linkBody = (o: Record<string, unknown>) => JSON.stringify({ deviceCode: 'dc', userCode: 'U', verifyUrl: 'https://app.example.test/link?code=U', interval: 3, expiresIn: 600, ...o });

  it('linkStart: interval clamped to 1–60 s (missing/NaN → 5), expiresIn to 1–1800 s (missing → 600)', async () => {
    expect(await answer(200, linkBody({ interval: 0, expiresIn: 99999 })).linkStart({ hostName: 'M', hostPub: 'p', uiVersion: '1.0.0' })).toMatchObject({ interval: 1, expiresIn: 1800 });
    expect(await answer(200, linkBody({ interval: 600, expiresIn: 0 })).linkStart({ hostName: 'M', hostPub: 'p', uiVersion: '1.0.0' })).toMatchObject({ interval: 60, expiresIn: 1 });
    expect(await answer(200, linkBody({ interval: 'x', expiresIn: undefined })).linkStart({ hostName: 'M', hostPub: 'p', uiVersion: '1.0.0' })).toMatchObject({ interval: 5, expiresIn: 600 });
  });

  it('linkStart / linkPoll: codes and tokens must be 1–512 char strings → else bad_response', async () => {
    const req = { hostName: 'M', hostPub: 'p', uiVersion: '1.0.0' };
    for (const bad of [{ deviceCode: '' }, { deviceCode: 5 }, { userCode: 'x'.repeat(513) }, { userCode: null }]) {
      await expect(answer(200, linkBody(bad)).linkStart(req)).rejects.toMatchObject({ status: 200, code: 'bad_response' });
    }
    await expect(answer(200, JSON.stringify({})).linkStart(req)).rejects.toMatchObject({ code: 'bad_response' });
    for (const bad of [{ hostId: '' }, { hostToken: 7 }, { hostToken: 'x'.repeat(513) }]) {
      await expect(answer(200, JSON.stringify({ state: 'linked', hostId: 'h', hostToken: 't', email: 'e@example.test', ...bad })).linkPoll('dc')).rejects.toMatchObject({ code: 'bad_response' });
    }
  });

  it('a 2xx body that is null or not an object → bad_response', async () => {
    for (const body of ['null', '"str"', '42', '', 'not json']) {
      await expect(answer(200, body).devices('tok')).rejects.toMatchObject({ status: 200, code: 'bad_response' });
    }
  });

  it('answers over 1 MiB → too_large (content-length first, then counted while streaming)', async () => {
    await expect(answer(200, '{}', { 'content-length': String(2 << 20) }).devices('tok')).rejects.toMatchObject({ status: 200, code: 'too_large' });
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 40) c.enqueue(chunk); else c.close(); } });
    await expect(answer(200, stream).devices('tok')).rejects.toMatchObject({ status: 200, code: 'too_large' });
    expect(sent).toBeLessThan(40); // stopped reading early
  });

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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementRes } from '../../shared/cloud/api-types';
import { CloudApi, CloudError } from './CloudApi';
import { CloudState } from './CloudState';
import { PlanView } from './PlanView';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const none: EntitlementRes = { plan: 'none', st: 'none', untilMs: 0, checkedAt: NOW };
const pro: EntitlementRes = { plan: 'pro', st: 'active', untilMs: NOW + 30 * DAY, checkedAt: NOW };

let dir: string;
let state: CloudState;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-planview-'));
  state = await CloudState.load(dir);
  await state.update({ hostId: 'h1', hostToken: 'tok', email: 'a@example.test' });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const view = (entitlement: (token: string) => Promise<EntitlementRes>, o: Partial<ConstructorParameters<typeof PlanView>[0]> = {}) => {
  const recheck = vi.fn();
  const api = { entitlement: vi.fn(entitlement) };
  const pv = new PlanView({ api: api as never, state, relay: { recheck }, now: () => NOW, ...o });
  return { pv, api, recheck };
};

describe('PlanView', () => {
  it('stores the plan and calls relay.recheck when it changes to a live plan', async () => {
    const recheck = vi.fn();
    const api = { entitlement: vi.fn().mockResolvedValueOnce(none).mockResolvedValueOnce(pro).mockResolvedValueOnce(pro) };
    const pv = new PlanView({ api: api as never, state, relay: { recheck }, now: () => NOW });
    expect(await pv.refresh()).toEqual(none);
    expect(recheck).not.toHaveBeenCalled();
    expect(await pv.refresh()).toEqual(pro);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(state.get().plan).toEqual(pro);
    expect(pv.get()).toEqual(pro);
    await pv.refresh(); // same plan again: no second recheck
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(api.entitlement).toHaveBeenCalledWith('tok');
  });

  it('a change to a plan that is already over does not recheck', async () => {
    await state.update({ plan: pro });
    const { pv, recheck } = view(async () => ({ plan: 'pro', st: 'canceled', untilMs: NOW - 1, checkedAt: NOW }));
    await pv.refresh();
    expect(recheck).not.toHaveBeenCalled();
    expect(state.get().plan).toMatchObject({ st: 'canceled' });
  });

  it('a network failure or 5xx keeps the stored plan', async () => {
    await state.update({ plan: pro });
    const errors: unknown[] = [];
    for (const err of [new CloudError(0, 'network'), new CloudError(503), new CloudError(429, 'rate_limited'), new CloudError(200, 'bad_response')]) {
      const { pv } = view(async () => { throw err; }, { onError: (e) => errors.push(e) });
      expect(await pv.refresh()).toEqual(pro);
      expect(state.get().plan).toEqual(pro);
    }
    expect(errors).toHaveLength(4);
  });

  it('a 401 answers null, keeps nothing new and reports it', async () => {
    const errors: unknown[] = [];
    const { pv } = view(async () => { throw new CloudError(401, 'unauthorized'); }, { onError: (e) => errors.push(e) });
    expect(await pv.refresh()).toBeNull();
    expect(errors).toEqual([expect.objectContaining({ status: 401 })]);
  });

  it('a bare 401 (no unauthorized code, e.g. a proxy) keeps the stored plan', async () => {
    await state.update({ plan: pro });
    const { pv } = view(async () => { throw new CloudError(401); });
    expect(await pv.refresh()).toEqual(pro);
  });

  it('a failed state write goes to onError instead of throwing (no onChange, no recheck)', async () => {
    await state.update({ plan: none });
    const errors: unknown[] = [];
    const onChange = vi.fn();
    const { pv, recheck } = view(async () => pro, { onError: (e) => errors.push(e), onChange });
    const boom = new Error('disk full');
    vi.spyOn(state, 'update').mockRejectedValueOnce(boom);
    expect(await pv.refresh()).toEqual(none); // what the state holds (the mocked write changed nothing)
    expect(errors).toEqual([boom]);
    expect(onChange).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });

  it('not linked: null and no request at all', async () => {
    await state.reset();
    const { pv, api } = view(async () => pro);
    expect(await pv.refresh()).toBeNull();
    expect(pv.get()).toBeNull();
    pv.start();
    expect(api.entitlement).not.toHaveBeenCalled();
    pv.stop();
  });

  it('concurrent refreshes share one request', async () => {
    let release!: (v: EntitlementRes) => void;
    const { pv, api } = view(() => new Promise<EntitlementRes>((r) => { release = r; }));
    const a = pv.refresh();
    const b = pv.refresh();
    release(pro);
    expect(await a).toEqual(pro);
    expect(await b).toEqual(pro);
    expect(api.entitlement).toHaveBeenCalledTimes(1);
  });

  /** A hand-driven setTimeout: records each delay, `fire()` runs the pending callback. */
  const manualTimer = () => {
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    const setTimer = ((cb: () => void, ms: number) => { delays.push(ms); pending = cb; return { unref() {} } as never; }) as unknown as typeof setTimeout;
    return { delays, setTimer, fire: () => { const cb = pending; pending = null; cb?.(); }, pending: () => pending !== null };
  };

  it('start(): at once, then every 6 h ±30 min; stop() ends it', async () => {
    const t = manualTimer();
    const { pv, api } = view(async () => none, { random: () => 0.5, setTimer: t.setTimer });
    pv.start();
    expect(api.entitlement).toHaveBeenCalledTimes(1);
    expect(t.delays).toEqual([6 * 3_600_000]);
    await pv.refresh();
    t.fire();
    expect(api.entitlement).toHaveBeenCalledTimes(2);
    expect(t.delays).toHaveLength(2);
    await pv.refresh(); // joins the timer's fetch
    expect(api.entitlement).toHaveBeenCalledTimes(2);
    pv.stop();
    expect(t.pending()).toBe(true); // stop() cleared the real handle; the hand-driven one just is not fired
  });

  it('the jitter stays within ±30 min', async () => {
    for (const [r, h] of [[0, 5.5], [1, 6.5]] as const) {
      const t = manualTimer();
      const { pv } = view(async () => none, { random: () => r, setTimer: t.setTimer });
      pv.start();
      expect(t.delays).toEqual([h * 3_600_000]);
      await pv.refresh(); // joins start()'s fetch, so no write outlives the test
      pv.stop();
    }
  });
});

describe('CloudApi.entitlement', () => {
  const answer = (body: unknown) =>
    new CloudApi({ baseUrl: 'https://app.example.test', fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });

  it('passes a well-formed answer through, extra fields dropped', async () => {
    expect(await answer({ ...pro, extra: 'x'.repeat(100) }).entitlement('tok')).toEqual(pro);
    expect(await answer(none).entitlement('tok')).toEqual(none);
  });

  it('anything else → bad_response', async () => {
    const bads: unknown[] = [
      [], {},
      { ...pro, plan: 'enterprise' }, { ...pro, plan: 'p'.repeat(5000) }, { ...pro, plan: 1 },
      { ...pro, st: 'paused' }, { ...pro, st: null },
      { ...pro, untilMs: -1 }, { ...pro, untilMs: '1' }, { ...pro, untilMs: Number.MAX_VALUE }, { ...pro, untilMs: 1.5 },
      { ...pro, checkedAt: 0 }, { ...pro, checkedAt: undefined },
    ];
    for (const b of bads) await expect(answer(b).entitlement('tok')).rejects.toMatchObject({ status: 200, code: 'bad_response' });
  });
});

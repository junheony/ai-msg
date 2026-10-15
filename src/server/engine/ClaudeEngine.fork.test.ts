import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeEngine } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';
import { fakeClaudeCli, cli, argValue } from './claudeCli/fakeClaudeCli';
import { PermissionBridge } from './claudeCli/bridge';
import { testRegistry } from '../../shared/accounts.testkit';

let bridge: PermissionBridge | null = null;
let tmp = '';
const PARENT = '11111111-2222-4333-8444-555555555555';
afterEach(async () => { await bridge?.close(); bridge = null; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: PARENT, model: 'opus', prompt: '고친 질문', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}

/** A parent transcript (session PARENT) u1 → a1 → u2 in a temp projects dir; the spawn wrapper reads the fork source while the child runs. */
async function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-fork-'));
  bridge = await PermissionBridge.open();
  const projects = path.join(tmp, 'projects');
  const cwd = path.join(tmp, 'w');
  fs.mkdirSync(cwd);
  const dir = path.join(projects, fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${PARENT}.jsonl`), [{ uuid: 'u1', parentUuid: null }, { uuid: 'a1', parentUuid: 'u1' }, { uuid: 'u2', parentUuid: 'a1' }].map((r) => JSON.stringify(r)).join('\n'));
  const f = fakeClaudeCli();
  const sources: string[] = [];
  const spawnFn: typeof f.spawnFn = (bin, args, o) => {
    const r = argValue(args, '--resume');
    if (r && r.endsWith('.jsonl')) sources.push(fs.readFileSync(r, 'utf8'));
    return f.spawnFn(bin, args, o);
  };
  const engine = new ClaudeEngine({ bin: 'claude', spawnFn, bridge, accounts: { ...testRegistry('/h'), projectsDir: () => projects }, baseEnv: {}, readFile: async () => Buffer.from(''), tmpRoot: tmp });
  return { f, engine, cwd, sources };
}
const drain = async (it: AsyncIterable<EngineEvent>) => { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; };

describe('메시지 편집 갈래: fork options', () => {
  it('forkAt resumes the parent as a fork cut at that entry', async () => {
    const { f, engine, cwd, sources } = await setup();
    f.push(cli.init('child'), cli.result('답', 'child'));
    await drain(engine.runTurn(req({ cwd, forkAt: 'a1' })));
    const args = f.spawns[0]!.args;
    expect(argValue(args, '--resume')).toMatch(new RegExp(`${PARENT}\\.jsonl$`));
    expect(args).toContain('--fork-session');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.trim().split('\n').map((l) => (JSON.parse(l) as { uuid: string }).uuid)).toEqual(['u1', 'a1']);
  });

  it('a plain resume does not fork', async () => {
    const { f, engine, cwd } = await setup();
    f.push(cli.init('parent'), cli.result('답', 'parent'));
    await drain(engine.runTurn(req({ cwd })));
    const args = f.spawns[0]!.args;
    expect(argValue(args, '--resume')).toBe(PARENT);
    expect(args).not.toContain('--fork-session');
  });

  it('the fork reports the id the CLI gives it, never the parent’s', async () => {
    const { f, engine, cwd } = await setup();
    f.push(cli.init('child'), cli.delta('답'), cli.result('답', 'child'));
    f.end();
    const evs = await drain(engine.runTurn(req({ cwd, forkAt: 'a1' })));
    expect(argValue(f.spawns[0]!.args, '--resume')).toMatch(new RegExp(`${PARENT}\\.jsonl$`));
    expect(f.spawns[0]!.args).toContain('--fork-session');
    expect(evs.find((e) => e.kind === 'init')).toMatchObject({ sessionId: 'child' });
    expect(evs.find((e) => e.kind === 'result')).toMatchObject({ sessionId: 'child', ok: true });
  });
});

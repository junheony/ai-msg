import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLine, type CliMessage } from './messages';
import { mapCliMessage, isActivity, BackgroundTracker } from './stream';
import { ToolTracker, toolAudit as mkAudit } from './stream';
import { toUserMessage } from './prompt';
import { fastFailureKind, fastModeKind, fastModeText } from './texts';
import { fakeClaudeCli, cli, argValue } from './fakeClaudeCli';

const fixture = (name: string): CliMessage[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean).map((l) => parseLine(l)!).filter(Boolean);

describe('parseLine', () => {
  it('accepts objects with a string type, rejects the rest', () => {
    expect(parseLine('{"type":"result","subtype":"success"}')).toMatchObject({ type: 'result' });
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('[1]')).toBeNull();
    expect(parseLine('{"no":"type"}')).toBeNull();
  });
});

describe('basic fixture (real CLI capture)', () => {
  const ms = fixture('basic.jsonl');
  it('maps init → deltas → result like the SDK stream did', () => {
    const evs = ms.flatMap(mapCliMessage);
    expect(evs[0]).toMatchObject({ kind: 'init' });
    expect(typeof (evs[0] as { sessionId: string }).sessionId).toBe('string');
    const text = evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text.toLowerCase()).toContain('pong');
    const result = evs.find((e) => e.kind === 'result') as { ok: boolean; text: string; usage: { outputTokens: number } };
    expect(result.ok).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
  it('A3/A4: our uuid comes back as a replay and in the result', () => {
    const ours = '00000000-0000-4000-8000-000000000001';
    const replay = ms.find((m) => m.type === 'user' && (m as Record<string, unknown>).isReplay === true);
    const result = ms.find((m) => m.type === 'result') as Record<string, unknown>;
    const named = [...((result.user_message_uuids as string[] | undefined) ?? []), result.user_message_uuid];
    // Both are what the engine relies on; if the capture recorded otherwise in basic.meta.json notes, this test documents it.
    expect(replay?.uuid ?? null).toBe(ours);
    expect(named).toContain(ours);
  });
  it('A5: assistant frames carry uuid and message.id; replay frames are not activity', () => {
    const a = ms.find((m) => m.type === 'assistant') as Record<string, unknown>;
    expect(typeof a.uuid).toBe('string');
    expect(typeof (a.message as Record<string, unknown>).id).toBe('string');
    expect(ms.filter((m) => m.type === 'user').every((m) => !isActivity(m))).toBe(true);
  });
});

describe('moved helpers keep behaving', () => {
  it('BackgroundTracker reads the level signal', () => {
    const bg = new BackgroundTracker(() => 1);
    expect(bg.apply(cli.bgLevel([{ id: 't1', desc: 'sleep' }]) as CliMessage)).toBe(true);
    expect(bg.tasks()).toEqual(['sleep']);
  });
  it('toUserMessage builds one stdin user message with image blocks', async () => {
    const m = await toUserMessage('hi', [{ path: '/x.png', name: 'x.png', mediaType: 'image/png', isImage: true } as never], async () => Buffer.from('PNG'));
    expect(m.type).toBe('user');
    expect(Array.isArray(m.message.content)).toBe(true);
    expect((m.message.content as { type: string }[]).map((b) => b.type)).toEqual(['text', 'image']);
  });
});

describe('fakeClaudeCli', () => {
  it('records argv, parses stdin lines, streams pushed frames and exits on stdin close', async () => {
    const fake = fakeClaudeCli();
    fake.push(cli.init('s9'));
    const child = fake.spawnFn('claude', ['-p', '--model', 'm', '--settings=/x'], { cwd: '/w', env: {} });
    const lines: string[] = [];
    child.stdout.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
    const exit = new Promise<[number | null, string | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    child.stdin.end();
    expect(await exit).toEqual([0, null]);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.state.inputClosed).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'system', subtype: 'init', session_id: 's9' });
    expect(argValue(fake.spawns[0]!.args, '--model')).toBe('m');
    expect(argValue(fake.spawns[0]!.args, '--settings')).toBe('/x');
  });
  it('SIGINT exits 130 by default, SIGTERM by signal', async () => {
    const fake = fakeClaudeCli();
    const a = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const ea = new Promise((r) => a.once('exit', (c, s) => r([c, s])));
    a.kill('SIGINT');
    expect(await ea).toEqual([130, null]);
    const b = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const eb = new Promise((r) => b.once('exit', (c, s) => r([c, s])));
    b.kill('SIGTERM');
    expect(await eb).toEqual([null, 'SIGTERM']);
    expect(fake.state.signals).toEqual(['SIGINT', 'SIGTERM']);
  });
});

describe('ToolTracker (replaces PostToolUse/PostToolUseFailure audit)', () => {
  const setup = () => {
    const seen: { toolUseId: string; decision: string; source: string }[] = [];
    const audit = mkAudit({ onToolAudit: async (e) => { seen.push(e); } });
    return { t: new ToolTracker(audit), audit, seen };
  };
  const use = (id: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } }) as CliMessage;
  const res = (id: string, isError = false, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] } }) as CliMessage;
  it('a successful result the CLI ran on its own → allow cli, once', async () => {
    const { t, seen } = setup();
    await t.apply(use('a'));
    await t.apply(res('a'));
    await t.apply(res('a'));
    expect(seen).toEqual([expect.objectContaining({ toolUseId: 'a', decision: 'allow', source: 'cli' })]);
  });
  it('subagent calls are audited too', async () => {
    const { t, seen } = setup();
    await t.apply(use('s', 'toolu_ag'));
    await t.apply(res('s', false, 'toolu_ag'));
    expect(seen.map((s) => s.toolUseId)).toEqual(['s']);
  });
  it('calls deck decided are skipped', async () => {
    const { t, audit, seen } = setup();
    audit.handled.add('b');
    await t.apply(use('b'));
    await t.apply(res('b'));
    expect(seen).toEqual([]);
  });
  it('error results wait for the turn result so a denial report wins', async () => {
    const { t, audit, seen } = setup();
    await t.apply(use('c'));
    await t.apply(res('c', true));
    expect(seen).toEqual([]);
    await audit.report({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'c' }, 'deny', 'rule');
    await t.apply({ type: 'result', subtype: 'success', session_id: 's' } as CliMessage);
    expect(seen).toEqual([expect.objectContaining({ toolUseId: 'c', decision: 'deny', source: 'rule' })]);
  });
  it('replayed tool results are ignored', async () => {
    const { t, seen } = setup();
    await t.apply(use('d'));
    await t.apply({ ...(res('d') as object), isReplay: true } as CliMessage);
    expect(seen).toEqual([]);
  });
});

describe('system/notification → notice', () => {
  it('plain notifications pass through; fast-mode ones get deck’s explanation; empty ones are dropped', () => {
    expect(mapCliMessage({ type: 'system', subtype: 'notification', key: 'k', text: 'Auto-compact failed' } as CliMessage)).toEqual([{ kind: 'notice', message: 'Auto-compact failed' }]);
    const [fast] = mapCliMessage({ type: 'system', subtype: 'notification', key: 'k', text: 'Fast mode cooldown triggered' } as CliMessage);
    expect(fast).toMatchObject({ kind: 'notice' });
    expect((fast as { message: string }).message).toMatch(/^⚡ Fast mode cooldown triggered — .*쿨다운/);
    expect(fast).toMatchObject({ fast: 'cooldown' });
    // A line merely naming fast mode is no fallback; a long notification is cut.
    expect(mapCliMessage({ type: 'system', subtype: 'notification', key: 'k', text: 'Fast mode is on' } as CliMessage)).toEqual([{ kind: 'notice', message: 'Fast mode is on' }]);
    const [long] = mapCliMessage({ type: 'system', subtype: 'notification', key: 'k', text: 'x'.repeat(5000) } as CliMessage);
    expect((long as { message: string }).message.length).toBe(300);
    expect(mapCliMessage({ type: 'system', subtype: 'notification', key: 'k', text: '  ' } as CliMessage)).toEqual([]);
  });
});

describe('fastModeKind', () => {
  it('reads the kind of a fast-mode line; on a failed fast turn any such line counts (unknown → off)', () => {
    expect(fastModeKind('Fast mode usage credits exhausted')).toBe('exhausted');
    expect(fastModeKind('Your organization has disabled fast mode')).toBe('org');
    expect(fastModeKind('Fast mode cooldown triggered')).toBe('cooldown');
    expect(fastModeKind('Fast mode requires usage credits')).toBe('off');
    expect(fastModeKind('Fast mode hiccup')).toBeNull();
    expect(fastModeKind('Fast mode hiccup', true)).toBe('off');
    expect(fastModeKind('API Error: 500', true)).toBeNull();
    for (const k of ['org', 'exhausted', 'off', 'cooldown'] as const) expect(fastModeText(k, true)).not.toContain('다시 시도');
  });
  it('fastFailureKind: any limit on a fast turn is a fast refusal; only an auth failure keeps its own handling', () => {
    expect(fastFailureKind('Fast mode usage credits exhausted', null)).toBe('exhausted');
    expect(fastFailureKind('API Error: 429 Fast mode rate limit exceeded', null)).toBe('cooldown');
    expect(fastFailureKind('API Error: 429', null)).toBe('cooldown');
    expect(fastFailureKind('boom', 'rate_limit')).toBe('cooldown');
    expect(fastFailureKind('boom', null, 'rejected')).toBe('cooldown');
    expect(fastFailureKind('Failed to authenticate (fast mode)', null)).toBeNull();
    expect(fastFailureKind('Fast mode unavailable', 'authentication_failed')).toBeNull();
    expect(fastFailureKind('API Error: 500', null)).toBeNull();
    expect(fastFailureKind(null, null)).toBeNull();
  });
});

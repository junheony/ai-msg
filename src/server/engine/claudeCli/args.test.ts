import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  claudeArgs, buildSettings, buildMcpConfig, relayCommand, shellQuote, claudeEnv, validResume,
  PERMISSION_TOOL, EDIT_TOOL_MATCHER, COMMANDER_TOOL_MATCHER, HOOK_TIMEOUT_S,
} from './args';

const base = { model: 'opus' as const, permissionMode: 'default' as const, settingsPath: '/t/p/settings.json', mcpConfigPath: '/t/p/mcp.json' };
const relay = { node: '/usr/bin/node', script: '/app/hookRelay.ts', socketPath: '/t/qd-1/bridge.sock', token: 'tok' };

describe('claudeArgs', () => {
  it('builds the fixed headless stream-json prefix', () => {
    const a = claudeArgs(base);
    expect(a.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(a).toContain('--replay-user-messages');
    expect(a).toEqual(expect.arrayContaining(['--permission-prompts', 'host', '--permission-prompt-tool', PERMISSION_TOOL]));
    expect(a).toEqual(expect.arrayContaining(['--setting-sources', 'user,project,local']));
    expect(a).toContain('--settings=/t/p/settings.json');
    expect(a).toContain('--mcp-config=/t/p/mcp.json');
    expect(a).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--permission-mode', 'default']));
  });
  it('never emits forbidden flags', () => {
    const a = claudeArgs({ ...base, resume: '11111111-2222-4333-8444-555555555555', forkSession: true, addDirs: ['/x'] });
    for (const f of ['--bare', '--strict-mcp-config', '--dangerously-skip-permissions']) expect(a).not.toContain(f);
  });
  it('effort, add-dir (absolute only), resume, fork, session-id', () => {
    const a = claudeArgs({ ...base, effort: 'high', addDirs: ['/abs', 'rel'], resume: '11111111-2222-4333-8444-555555555555', forkSession: true });
    expect(a).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(a).toContain('--add-dir=/abs');
    expect(a.some((x) => x.includes('rel'))).toBe(false);
    expect(a).toContain('--resume=11111111-2222-4333-8444-555555555555');
    expect(a).toContain('--fork-session');
    const n = claudeArgs({ ...base, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(n).toContain('--session-id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
  it('rejects malformed resume values instead of passing them through', () => {
    expect(() => claudeArgs({ ...base, resume: '--bare' })).toThrow();
    expect(validResume('/t/p/fork.jsonl')).toBe(true);
    expect(validResume('fork.jsonl')).toBe(false);
  });
  it('session-id is ignored together with resume', () => {
    const a = claudeArgs({ ...base, resume: '11111111-2222-4333-8444-555555555555', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(a.some((x) => x.startsWith('--session-id'))).toBe(false);
  });
});

describe('buildSettings', () => {
  it('allow rules and a fail-open edit-gate hook', () => {
    const s = buildSettings({ allowRules: ['Bash(npm test:*)'], relay }) as any;
    expect(s.permissions).toEqual({ allow: ['Bash(npm test:*)'] });
    expect(s.hooks.PreToolUse[0].matcher).toBe(EDIT_TOOL_MATCHER);
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 30 });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'open'");
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
  });
  it('noTools gates every tool and fails closed', () => {
    const s = buildSettings({ noTools: true, relay }) as any;
    expect(s.hooks.PreToolUse[0].matcher).toBe('*');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'deny'");
  });
  it('systemNote adds a UserPromptSubmit relay', () => {
    const s = buildSettings({ systemNote: 'note', relay }) as any;
    expect(s.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
    expect(JSON.stringify(s)).not.toContain('note"'); // the note itself is served over the bridge, not written to disk
  });
});

describe('buildSettings — 총사령탑 자동 턴(commander)', () => {
  const rules = ['Bash(npm test:*)', 'Bash', 'mcp__github__create_issue', 'Edit(/w/**)', 'WebFetch(domain:example.com)'];
  it('without commander the output is unchanged (byte for byte)', () => {
    for (const s of [{ allowRules: rules, relay }, { relay }, { systemNote: 'n', relay }, { noTools: true, allowRules: rules, relay }]) {
      expect(JSON.stringify(buildSettings({ ...s, commander: false }))).toBe(JSON.stringify(buildSettings(s)));
    }
  });
  it('보안 #4·#5: one PreToolUse hook for every tool (matcher .*), relayed fail-closed', () => {
    const s = buildSettings({ allowRules: rules, commander: true, relay }) as any;
    expect(COMMANDER_TOOL_MATCHER).toBe('.*');
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(s.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: HOOK_TIMEOUT_S });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'closed'");
  });
  it('without commander the relay modes stay open / deny', () => {
    const plain = buildSettings({ systemNote: 'n', relay }) as any;
    expect(plain.hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'open'");
    expect((buildSettings({ noTools: true, relay }) as any).hooks.PreToolUse[0].hooks[0].command).toContain("'--fail' 'deny'");
  });
  it('Bash and mcp__ allow rules never reach permissions.allow; the others stay', () => {
    const s = buildSettings({ allowRules: rules, commander: true, relay }) as any;
    expect(s.permissions).toEqual({ allow: ['Edit(/w/**)', 'WebFetch(domain:example.com)'] });
    expect(buildSettings({ allowRules: ['Bash(ls)', 'mcp__x__y'], commander: true, relay })).not.toHaveProperty('permissions');
    expect(buildSettings({ allowRules: ['BashOutput'], commander: true, relay })).toHaveProperty('permissions', { allow: ['BashOutput'] });
  });
  it('noTools wins over commander (every tool denied)', () => {
    const s = buildSettings({ noTools: true, commander: true, relay }) as any;
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('*');
  });
  it('the UserPromptSubmit note hook is the same with or without commander', () => {
    const a = buildSettings({ systemNote: 'n', commander: true, relay }) as any;
    const b = buildSettings({ systemNote: 'n', relay }) as any;
    expect(a.hooks.UserPromptSubmit).toEqual(b.hooks.UserPromptSubmit);
  });
});

describe('relayCommand / shellQuote', () => {
  it('quotes every part; the token travels as an env prefix, never as a node argv flag', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(relayCommand(relay, 'open')).toBe(
      `DECK_BRIDGE_TOKEN='tok' '/usr/bin/node' '--disable-warning=ExperimentalWarning' '/app/hookRelay.ts' '--sock' '/t/qd-1/bridge.sock' '--fail' 'open'`,
    );
    expect(relayCommand(relay, 'open')).not.toContain('--token');
  });  it('재검토 #3: closed is wrapped so any non-zero exit becomes 2; open / deny are not wrapped', () => {
    expect(relayCommand(relay, 'closed')).toBe(
      `( DECK_BRIDGE_TOKEN='tok' '/usr/bin/node' '--disable-warning=ExperimentalWarning' '/app/hookRelay.ts' '--sock' '/t/qd-1/bridge.sock' '--fail' 'closed' ) || exit 2`,
    );
    expect(relayCommand(relay, 'deny')).not.toContain('exit 2');
    const s = buildSettings({ systemNote: 'n', commander: true, relay }) as any;
    expect(s.hooks.PreToolUse[0].hooks[0].command).toMatch(/\) \|\| exit 2$/);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).not.toContain('exit 2');
  });
  it('재검토 #3: run through sh — a SIGKILLed or missing relay exits 2 when closed; exit 0 + JSON passes through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-relaycmd-'));
    try {
      const fake = (name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return f; };
      const sh = (cmd: string) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', input: '{}' });
      const killed = fake('killed', 'kill -9 $$');
      const answer = fake('answer', `cat >/dev/null; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask"}}'; exit 0`);
      const missing = path.join(dir, 'no-such-node');
      // before: the bare command dies by SIGKILL (sh may exec it: no status at all) / exits 127 — not 2, so the CLI would run the tool
      expect(sh(relayCommand({ ...relay, node: killed }, 'open')).status).not.toBe(2);
      expect(sh(relayCommand({ ...relay, node: missing }, 'open')).status).toBe(127);
      expect(sh(relayCommand({ ...relay, node: killed }, 'closed')).status).toBe(2);
      expect(sh(relayCommand({ ...relay, node: missing }, 'closed')).status).toBe(2);
      expect(sh(relayCommand({ ...relay, node: fake('one', 'exit 1') }, 'closed')).status).toBe(2);
      const ok = sh(relayCommand({ ...relay, node: answer }, 'closed'));
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({ hookSpecificOutput: { permissionDecision: 'ask' } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildMcpConfig', () => {
  it('one stdio server, token only in its env', () => {
    const m = buildMcpConfig({ node: '/usr/bin/node', script: '/app/permissionMcp.ts', socketPath: '/s', token: 'tok' }) as any;
    expect(m).toEqual({ mcpServers: { deck_bridge: {
      type: 'stdio', command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', '/app/permissionMcp.ts'],
      env: { DECK_BRIDGE_SOCK: '/s', DECK_BRIDGE_TOKEN: 'tok' },
    } } });
  });
});

describe('claudeEnv', () => {
  it('adds the MCP tool timeout and never sets the SDK entrypoint', () => {
    const e = claudeEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/p' }, 43_200_000);
    expect(e).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/p', MCP_TOOL_TIMEOUT: '43200000' });
    expect('CLAUDE_CODE_ENTRYPOINT' in e).toBe(false);
  });
  it('drops an inherited entrypoint / SDK version', () => {
    const e = claudeEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '1' }, 1);
    expect(e.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(e.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
  });
});

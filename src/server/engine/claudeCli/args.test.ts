import { describe, it, expect } from 'vitest';
import {
  claudeArgs, buildSettings, buildMcpConfig, relayCommand, shellQuote, claudeEnv, validResume,
  PERMISSION_TOOL, EDIT_TOOL_MATCHER,
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

describe('relayCommand / shellQuote', () => {
  it('quotes every part; the token travels as an env prefix, never as a node argv flag', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(relayCommand(relay, 'open')).toBe(
      `DECK_BRIDGE_TOKEN='tok' '/usr/bin/node' '--disable-warning=ExperimentalWarning' '/app/hookRelay.ts' '--sock' '/t/qd-1/bridge.sock' '--fail' 'open'`,
    );
    expect(relayCommand(relay, 'open')).not.toContain('--token');
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

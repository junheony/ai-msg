import { describe, it, expect } from 'vitest';
import { scrubLine } from './scrub';

const ctx = { home: '/home/alice', cwd: '/tmp/tmp.Xy12' };

describe('scrubLine', () => {
  it('replaces the home dir, its project slug and the temp cwd', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'x', a: '/home/alice/.claude/projects/-home-alice-proj/s.jsonl', cwd: '/tmp/tmp.Xy12' });
    const out = JSON.parse(scrubLine(line, ctx));
    expect(out.a).toBe('/home/user/.claude/projects/-home-user-proj/s.jsonl');
    expect(out.cwd).toBe('/work');
  });
  it('removes e-mail addresses and tailnet host names', () => {
    const out = scrubLine(JSON.stringify({ type: 'x', e: 'alice@example.org', h: 'box.tail1234.ts.net' }), ctx);
    expect(out).not.toContain('alice@');
    expect(out).not.toContain('ts.net');
  });
  it('trims init inventories to what tests need', () => {
    const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '/tmp/tmp.Xy12',
      tools: ['Bash', 'mcp__private__x', 'mcp__deck_bridge__permission'], slash_commands: ['compact', 'private-cmd'],
      mcp_servers: [{ name: 'private', status: 'connected' }, { name: 'deck_bridge', status: 'connected' }],
      skills: ['s'], plugins: [{ name: 'p' }], agents: ['a'] };
    const out = JSON.parse(scrubLine(JSON.stringify(init), ctx));
    expect(out.tools).toEqual(['Bash', 'mcp__deck_bridge__permission']);
    expect(out.slash_commands).toEqual(['compact']);
    expect(out.mcp_servers).toEqual([{ name: 'deck_bridge', status: 'connected' }]);
    expect(out.skills).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.agents).toEqual([]);
  });
  it('folds a named profile dir (CLAUDE_CONFIG_DIR) into ~/.claude', () => {
    const out = JSON.parse(scrubLine(JSON.stringify({ type: 'system', subtype: 'init', memory_paths: { auto: '/home/alice/.claude-b/projects/-work/memory/' } }), ctx));
    expect(out.memory_paths.auto).toBe('/home/user/.claude/projects/-work/memory/');
  });
  it("drops frames carrying the user's own hook output (empty string)", () => {
    for (const subtype of ['hook_started', 'hook_progress', 'hook_response', 'informational']) {
      expect(scrubLine(JSON.stringify({ type: 'system', subtype, output: 'private' }), ctx)).toBe('');
    }
    expect(scrubLine(JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }), ctx)).not.toBe('');
  });
  it('passes non-JSON lines through after text scrubbing', () => {
    expect(scrubLine('oops /home/alice/x', ctx)).toBe('oops /home/user/x');
  });
});

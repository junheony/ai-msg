import { describe, it, expect } from 'vitest';
import { parseClaudeVersion, resolveClaudeBin, MIN_CLAUDE_VERSION, RECOMMENDED_CLAUDE_VERSION } from './version';

const HOME = '/home/u';

describe('parseClaudeVersion', () => {
  it('reads "2.1.283 (Claude Code)"', () => expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283'));
  it('null on garbage / null', () => {
    expect(parseClaudeVersion('nope')).toBeNull();
    expect(parseClaudeVersion(null)).toBeNull();
  });
});

describe('resolveClaudeBin', () => {
  const versions: Record<string, string> = {
    '/old/claude': '2.1.200 (Claude Code)',
    '/new/claude': '2.1.283 (Claude Code)',
    '/mid/claude': '2.1.260 (Claude Code)',
    [`${HOME}/.local/bin/claude`]: '2.1.290 (Claude Code)',
  };
  const exists = (p: string) => p in versions;
  const ver = (p: string) => versions[p] ?? null;

  it('first qualifying PATH entry wins, older ones skipped', () => {
    const r = resolveClaudeBin({ PATH: '/old:/new' }, HOME, exists, ver);
    expect(r).toEqual({ ok: true, bin: '/new/claude', version: '2.1.283', belowRecommended: false });
  });
  it('flags a binary between minimum and recommended', () => {
    const r = resolveClaudeBin({ PATH: '/mid' }, HOME, exists, ver);
    expect(r).toEqual({ ok: true, bin: '/mid/claude', version: '2.1.260', belowRecommended: true });
  });
  it('falls back to ~/.local/bin/claude', () => {
    const r = resolveClaudeBin({ PATH: '/nowhere' }, HOME, exists, ver);
    expect(r).toMatchObject({ ok: true, bin: `${HOME}/.local/bin/claude` });
  });
  it('reports too_old when only old binaries exist', () => {
    const r = resolveClaudeBin({ PATH: '/old' }, '/empty', exists, ver);
    expect(r).toEqual({ ok: false, reason: 'too_old', bin: '/old/claude', version: '2.1.200' });
  });
  it('reports missing when nothing exists', () => {
    expect(resolveClaudeBin({ PATH: '' }, '/empty', () => false, () => null)).toEqual({ ok: false, reason: 'missing' });
  });
  it('DECK_CLAUDE_BIN overrides PATH but is still version-gated', () => {
    expect(resolveClaudeBin({ PATH: '/new', DECK_CLAUDE_BIN: '/mid/claude' }, HOME, exists, ver)).toMatchObject({ ok: true, bin: '/mid/claude' });
    expect(resolveClaudeBin({ PATH: '/new', DECK_CLAUDE_BIN: '/old/claude' }, HOME, exists, ver)).toMatchObject({ ok: false, reason: 'too_old' });
  });
  it('constants', () => {
    expect(MIN_CLAUDE_VERSION).toBe('2.1.259');
    expect(RECOMMENDED_CLAUDE_VERSION).toBe('2.1.283');
  });
});

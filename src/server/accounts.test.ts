import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProfileNames, loadAccountRegistry } from './accounts';

describe('account registry loader', () => {
  let home: string;
  let configDir: string;
  let logs: string[];
  const load = () => loadAccountRegistry({ configDir, homeDir: home, log: (l) => logs.push(l) });
  const profile = (name: string, marker: 'projects' | '.claude.json' | null = 'projects') => {
    fs.mkdirSync(path.join(home, name), { recursive: true });
    if (marker === 'projects') fs.mkdirSync(path.join(home, name, 'projects'));
    if (marker === '.claude.json') fs.writeFileSync(path.join(home, name, '.claude.json'), '{}');
  };
  const writeConfig = (text: string) => fs.writeFileSync(path.join(configDir, 'accounts.json'), text);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acct-'));
    configDir = path.join(home, '.config', 'deck');
    fs.mkdirSync(configDir, { recursive: true });
    logs = [];
  });

  it('no accounts.json: discovers ~/.claude, ~/.claude-b, ~/.claude-c exactly like the old constants', () => {
    profile('.claude', null);
    profile('.claude-c');
    profile('.claude-b', '.claude.json');
    // Not accounts: plain files (logs, ~/.claude.json and its backup) and names that are not ids.
    for (const f of ['.claude-creds-sync.log', '.claude-creds-sync.stderr', '.claude.json', '.claude.json.backup', '.claude-d']) fs.writeFileSync(path.join(home, f), '');
    const r = load();
    expect(r.list()).toEqual(['a', 'b', 'c']);
    expect(r.home).toBe('a');
    expect(r.projectsRoots()).toEqual({ a: path.join(home, '.claude/projects'), b: path.join(home, '.claude-b/projects'), c: path.join(home, '.claude-c/projects') });
    expect(r.list().map((a) => r.cardId(a))).toEqual(['claude:main', 'claude:second', 'claude:third']);
    expect('CLAUDE_CONFIG_DIR' in r.env('a', { CLAUDE_CONFIG_DIR: '/x' })).toBe(false);
    expect(r.env('b', {}).CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-b'));
    expect(logs).toEqual([]);
  });

  it('a ~/.claude-<x> directory without a profile marker (projects/ or .claude.json) is not an account', () => {
    profile('.claude', null);
    profile('.claude-b');
    profile('.claude-backup', null);
    profile('.claude-mem', null);
    expect(discoverProfileNames(home)).toEqual(['.claude', '.claude-b']);
    expect(load().list()).toEqual(['a', 'b']);
  });

  it('a symlinked profile directory counts', () => {
    profile('.claude', null);
    profile('elsewhere');
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '.claude-w'));
    expect(load().list()).toEqual(['a', 'w']);
  });

  it('an empty or unreadable home still yields account a', () => {
    expect(load().list()).toEqual(['a']);
    const r = loadAccountRegistry({ configDir, homeDir: path.join(home, 'missing'), log: (l) => logs.push(l) });
    expect(r.list()).toEqual(['a']);
    expect(r.home).toBe('a');
  });

  it('accounts.json wins over discovery', () => {
    profile('.claude', null);
    profile('.claude-b');
    writeConfig(JSON.stringify({ version: 1, home: 'w', futureField: true, accounts: [
      { id: 'w', label: 'Work', configDir: '~/.claude-work', card: 'claude:work1', extra: 1 },
      { id: 'a' },
      { id: 'c', retired: true },
    ] }));
    const r = load();
    expect(r.list()).toEqual(['w', 'a']);
    expect(r.all()).toEqual(['w', 'a', 'c']);
    expect(r.home).toBe('w');
    expect(r.label('w')).toBe('Work');
    expect(r.profileDir('w')).toBe(path.join(home, '.claude-work'));
    expect(r.cardId('w')).toBe('claude:work1');
    expect(logs).toEqual([]);
  });

  it.each([
    ['broken JSON', '{ "version": 1, '],
    ['not an object', '[]'],
    ['unknown version', JSON.stringify({ version: 2, accounts: [{ id: 'a' }] })],
    ['bad id', JSON.stringify({ version: 1, accounts: [{ id: 'A' }] })],
    ['duplicate id', JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'a' }] })],
    ['missing home', JSON.stringify({ version: 1, home: 'z', accounts: [{ id: 'a' }] })],
    ['wrong field type', JSON.stringify({ version: 1, accounts: [{ id: 'a', retired: 'yes' }] })],
    ['no active account', JSON.stringify({ version: 1, accounts: [{ id: 'a', retired: true }] })],
  ])('%s: logs why and falls back to discovery (the server still starts)', (_name, text) => {
    profile('.claude', null);
    profile('.claude-b');
    writeConfig(text);
    const r = load();
    expect(r.list()).toEqual(['a', 'b']);
    expect(r.home).toBe('a');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(path.join(configDir, 'accounts.json'));
    expect(logs[0]).toContain('기본 발견');
  });

  it('an accounts.json that is a directory (unreadable) also falls back with a log', () => {
    profile('.claude', null);
    fs.mkdirSync(path.join(configDir, 'accounts.json'));
    expect(load().list()).toEqual(['a']);
    expect(logs).toHaveLength(1);
  });
});

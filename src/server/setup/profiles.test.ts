import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccountRegistry } from '../accounts';
import { buildRegistry } from '../../shared/accounts';
import { ProfileError, addClaudeProfile, materializeAccountsConfig } from './profiles';

let home: string;
let configDir: string;
const accountsFile = () => path.join(configDir, 'accounts.json');
const readIds = () => (JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) as { accounts: { id: string }[] }).accounts.map((a) => a.id);
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const profile = (name: string) => fs.mkdirSync(path.join(home, name, 'projects'), { recursive: true });
const add = (id: string, extra: Partial<Parameters<typeof addClaudeProfile>[0]> = {}) => addClaudeProfile({ configDir, home, id, ...extra });
const failure = async (p: Promise<unknown>): Promise<ProfileError> => {
  try { await p; } catch (e) { if (e instanceof ProfileError) return e; throw e; }
  throw new Error('expected a ProfileError');
};

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-profiles-')));
  home = path.join(root, 'home');
  configDir = path.join(root, 'config');
  fs.mkdirSync(home);
  fs.mkdirSync(configDir);
});
afterEach(() => { fs.rmSync(path.dirname(home), { recursive: true, force: true }); });

describe('materializeAccountsConfig', () => {
  it('materialize round-trip keeps a discovered a/b/c install identical', () => {
    for (const d of ['.claude', '.claude-b', '.claude-c']) profile(d);
    const reg = loadAccountRegistry({ configDir, homeDir: home, log: () => {} });
    const config = materializeAccountsConfig(reg, home);
    const back = buildRegistry(config, { homeDir: home });
    expect(back.all()).toEqual(reg.all());
    expect(back.home).toBe(reg.home);
    for (const id of reg.all()) {
      expect(back.profileDir(id)).toBe(reg.profileDir(id));
      expect(back.cardId(id)).toBe(reg.cardId(id));
      expect(back.label(id)).toBe(reg.label(id));
    }
    expect(config.accounts.every((a) => a.card === undefined && a.label === undefined && a.configDir?.startsWith('~/'))).toBe(true);
  });

  it('keeps a non-default label, retired flags and a dir outside home', () => {
    const reg = buildRegistry({ version: 1, home: 'b', accounts: [{ id: 'a', retired: true }, { id: 'b', label: 'Work' }, { id: 'z', configDir: '/srv/claude-z' }] }, { homeDir: home });
    const config = materializeAccountsConfig(reg, home);
    expect(config).toEqual({ version: 1, home: 'b', accounts: [{ id: 'a', configDir: '~/.claude', retired: true }, { id: 'b', label: 'Work', configDir: '~/.claude-b' }, { id: 'z', configDir: '/srv/claude-z' }] });
  });
});

describe('addClaudeProfile', () => {
  it('first add on a discovered install writes all old accounts plus the new one', async () => {
    for (const d of ['.claude', '.claude-b', '.claude-c']) profile(d);
    const r = await add('d');
    expect(r).toMatchObject({ id: 'd', dir: path.join(home, '.claude-d'), createdDir: true, backup: null });
    expect(readIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(mode(accountsFile())).toBe(0o600);
    expect(mode(path.join(home, '.claude-d'))).toBe(0o700);
    const reg = loadAccountRegistry({ configDir, homeDir: home, log: () => {} });
    expect(reg.home).toBe('a');
    expect(reg.profileDir('d')).toBe(path.join(home, '.claude-d'));
    expect(reg.cardId('b')).toBe('claude:second');
  });

  it('first add re-discovers: a profile dir created after start is kept', async () => {
    for (const d of ['.claude', '.claude-b']) profile(d);
    loadAccountRegistry({ configDir, homeDir: home, log: () => {} }); // the server's start
    profile('.claude-e');
    await add('d');
    expect(readIds()).toEqual(['a', 'b', 'e', 'd']);
  });

  it('rejects reserved, malformed and duplicate ids', async () => {
    for (const d of ['.claude', '.claude-b']) profile(d);
    expect((await failure(add('gpt'))).status).toBe(400);
    expect((await failure(add('A!'))).status).toBe(400);
    const dup = await failure(add('b'));
    expect(dup.status).toBe(409);
    expect(dup.message).toBe('이미 있는 계정입니다: b');
    expect(fs.existsSync(accountsFile())).toBe(false);
  });

  it('a label is written when given', async () => {
    profile('.claude');
    await add('d', { label: 'Side' });
    const file = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) as { accounts: { id: string; label?: string }[] };
    expect(file.accounts.find((a) => a.id === 'd')?.label).toBe('Side');
  });

  it('an existing profile dir is registered, its files untouched', async () => {
    profile('.claude');
    const dir = path.join(home, '.claude-d');
    fs.mkdirSync(dir, { mode: 0o755 });
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, '{"x":1}');
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(f, past, past);
    const before = fs.statSync(f).mtimeMs;
    const r = await add('d');
    expect(r.createdDir).toBe(false);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"x":1}');
    expect(fs.statSync(f).mtimeMs).toBe(before);
    expect(mode(dir)).toBe(0o755);
    expect(readIds()).toEqual(['a', 'd']);
  });

  it('a broken accounts.json is refused, not overwritten', async () => {
    fs.writeFileSync(accountsFile(), '{ not json');
    const e = await failure(add('d'));
    expect(e.status).toBe(400);
    expect(fs.readFileSync(accountsFile(), 'utf8')).toBe('{ not json');
    expect(fs.existsSync(path.join(home, '.claude-d'))).toBe(false);
  });

  it('backs up an existing accounts.json once before the first edit, keeping unknown fields', async () => {
    const original = JSON.stringify({ version: 1, note: 'mine', accounts: [{ id: 'a' }, { id: 'b', card: 'claude:custom' }] });
    fs.writeFileSync(accountsFile(), original);
    const r = await add('d', { now: () => new Date(2026, 9, 21, 9, 8, 7) });
    expect(r.backup).toBe(path.join(configDir, 'accounts.json.bak-20261021-090807'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toBe(original);
    expect(mode(r.backup!)).toBe(0o600);
    await add('e');
    expect(fs.readdirSync(configDir).filter((n) => n.startsWith('accounts.json.bak-'))).toHaveLength(1);
    const file = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) as { note: string; accounts: { id: string; card?: string }[] };
    expect(file.note).toBe('mine');
    expect(file.accounts.map((a) => a.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(file.accounts[1]!.card).toBe('claude:custom');
  });

  it('a symlinked accounts.json or profile dir is refused', async () => {
    const real = path.join(configDir, 'real.json');
    const content = JSON.stringify({ version: 1, accounts: [{ id: 'a' }] });
    fs.writeFileSync(real, content);
    fs.symlinkSync(real, accountsFile());
    expect((await failure(add('d'))).status).toBe(400);
    expect(fs.readFileSync(real, 'utf8')).toBe(content);
    fs.rmSync(accountsFile());

    profile('.claude');
    const target = path.join(home, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(home, '.claude-d'));
    expect((await failure(add('d'))).status).toBe(400);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.existsSync(accountsFile())).toBe(false);
  });

  it('a change between read and write is refused (409), nothing written', async () => {
    fs.writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: [{ id: 'a' }] }));
    const edited = JSON.stringify({ version: 1, accounts: [{ id: 'a' }, { id: 'q' }] });
    const e = await failure(add('d', { hooks: { afterRead: () => fs.writeFileSync(accountsFile(), edited) } }));
    expect(e.status).toBe(409);
    expect(fs.readFileSync(accountsFile(), 'utf8')).toBe(edited);
    expect(fs.existsSync(path.join(home, '.claude-d'))).toBe(false);
    expect(fs.readdirSync(configDir).filter((n) => n.includes('.tmp') || n.endsWith('.lock'))).toEqual([]);
  });

  it('a file that appears between read and write is a change too', async () => {
    profile('.claude');
    const e = await failure(add('d', { hooks: { afterRead: () => fs.writeFileSync(accountsFile(), JSON.stringify({ version: 1, accounts: [{ id: 'a' }] })) } }));
    expect(e.status).toBe(409);
  });

  it('concurrent adds are serialized: both land', async () => {
    profile('.claude');
    await Promise.all([add('d'), add('e')]);
    expect(readIds().sort()).toEqual(['a', 'd', 'e']);
  });

  it('a stale lock left by another process is taken over; a fresh one is waited for, then refused', async () => {
    profile('.claude');
    const lock = path.join(configDir, 'accounts.json.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await add('d');
    expect(fs.existsSync(lock)).toBe(false);
    fs.writeFileSync(lock, '');
    const e = await failure(add('e', { lockWaitMs: 50 }));
    expect(e.status).toBe(409);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('a failed write removes only the empty dir it created', async () => {
    profile('.claude');
    const rename = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    await expect(add('d', { hooks: { rename } })).rejects.toThrow('disk full');
    expect(fs.existsSync(path.join(home, '.claude-d'))).toBe(false);
    fs.mkdirSync(path.join(home, '.claude-e'));
    await expect(add('e', { hooks: { rename } })).rejects.toThrow('disk full');
    expect(fs.existsSync(path.join(home, '.claude-e'))).toBe(true);
    expect(fs.existsSync(accountsFile())).toBe(false);
    expect(fs.readdirSync(configDir)).toEqual([]);
  });
});

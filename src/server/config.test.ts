import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readDeckSeen, readDeckUrl, readProtect, resolveGrokBin, supervisorOf, usageModeOf } from './config';
import { writeCooldown } from './routing/cooldown';
import { testRegistry } from '../shared/accounts.testkit';

describe('config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-'));

  it('readProtect skips comments/blank lines and validates', () => {
    const f = path.join(dir, 'protect');
    fs.writeFileSync(f, '# Desktop account\n\na\n');
    expect(readProtect(f, testRegistry())).toBe('a');
    fs.writeFileSync(f, 'z\n');
    const warned: string[] = [];
    expect(readProtect(f, testRegistry(), (l) => warned.push(l))).toBeNull();
    // An id that is not a configured account protects nothing — said once, with the file and the known accounts.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"z"');
    expect(warned[0]).toContain(f);
    expect(readProtect(path.join(dir, 'missing'), testRegistry(), (l) => warned.push(l))).toBeNull();
    expect(warned).toHaveLength(1);
  });

  it('readDeckUrl trims and falls back', () => {
    const f = path.join(dir, 'deck_url');
    fs.writeFileSync(f, 'http://100.64.0.2:9310  \n');
    expect(readDeckUrl(f)).toBe('http://100.64.0.2:9310');
    expect(readDeckUrl(path.join(dir, 'nope'))).toBe('http://127.0.0.1:9310');
  });

  it('DECK_USAGE_STRICT: 1 → strict, 0 → lax, anything else → decided by <configDir>/usage-source.json', () => {
    const home = path.join(dir, 'home-usage');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const of = (v?: string) => loadConfig({ DECK_CONFIG_DIR: '/cfg', ...(v === undefined ? {} : { DECK_USAGE_STRICT: v }) }, home, '/repo');
    expect(of()).toMatchObject({ usageStrict: null, usageSourceFile: '/cfg/usage-source.json' });
    expect(of('1').usageStrict).toBe(true);
    expect(of('0').usageStrict).toBe(false);
    expect(of('').usageStrict).toBeNull();
    expect(of('yes').usageStrict).toBeNull();
  });

  it('DECK_SUPERVISED=1 marks a supervised server; repoRoot is the source root', () => {
    const home = path.join(dir, 'home-sup');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    expect(loadConfig({ DECK_CONFIG_DIR: '/cfg' }, home, '/repo')).toMatchObject({ supervised: false, repoRoot: '/repo' });
    expect(loadConfig({ DECK_CONFIG_DIR: '/cfg', DECK_SUPERVISED: '1' }, home, '/repo').supervised).toBe(true);
  });

  it('Claude Desktop session metadata follows the macOS app path only on darwin', () => {
    const home = path.join(dir, 'home-desk');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const cfg = loadConfig({ DECK_CONFIG_DIR: '/cfg' }, home, '/repo');
    if (process.platform === 'darwin') expect(cfg.desktopSessionsRoot).toBe(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
    else expect(cfg.desktopSessionsRoot).toBe('');
    expect(loadConfig({ DECK_CONFIG_DIR: '/cfg', DECK_DESKTOP_SESSIONS_DIR: '/opt/desktop' }, home, '/repo').desktopSessionsRoot).toBe('/opt/desktop');
  });

  it('supervisor: DECK_SUPERVISOR systemd|launchd, else relaunch for DECK_SUPERVISED=1, else null', () => {
    expect(supervisorOf({})).toBeNull();
    expect(supervisorOf({ DECK_SUPERVISED: '1' })).toBe('relaunch');
    expect(supervisorOf({ DECK_SUPERVISOR: 'systemd' })).toBe('systemd');
    expect(supervisorOf({ DECK_SUPERVISOR: 'launchd', DECK_SUPERVISED: '1' })).toBe('launchd');
    expect(supervisorOf({ DECK_SUPERVISOR: 'cron' })).toBeNull();
  });

  it('deckUrlConfigured: true only when the address was set (DECK_URL or the claude-pick file), not for the default', () => {
    const home = path.join(dir, 'home-deck-url');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const of = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DECK_CONFIG_DIR: '/cfg', ...env }, home, '/repo');
    expect(of()).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    expect(of({ DECK_URL: '' })).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    expect(of({ DECK_URL: 'http://deck:9310' })).toMatchObject({ deckUrl: 'http://deck:9310', deckUrlConfigured: true });
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), '\n');
    expect(of()).toMatchObject({ deckUrl: 'http://127.0.0.1:9310', deckUrlConfigured: false });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://100.64.0.1:9310\n');
    expect(of()).toMatchObject({ deckUrl: 'http://100.64.0.1:9310', deckUrlConfigured: true });
    expect(of({ DECK_URL: 'http://deck:9310' })).toMatchObject({ deckUrl: 'http://deck:9310', deckUrlConfigured: true });
  });

  it('DECK_USAGE_SOURCE: explicit cli/usage-deck wins; otherwise usage-deck only when the address was set by the user, else cli', () => {
    expect(usageModeOf({}, false)).toBe('cli');
    expect(usageModeOf({}, true)).toBe('usage-deck');
    expect(usageModeOf({ DECK_USAGE_SOURCE: 'cli' }, true)).toBe('cli');
    expect(usageModeOf({ DECK_USAGE_SOURCE: 'usage-deck' }, false)).toBe('usage-deck');
    expect(usageModeOf({ DECK_USAGE_SOURCE: ' cli ' }, true)).toBe('cli');
    expect(usageModeOf({ DECK_USAGE_SOURCE: 'oauth' }, false)).toBe('cli');
    expect(usageModeOf({ DECK_USAGE_SOURCE: '' }, true)).toBe('usage-deck');
    const home = path.join(dir, 'home-usage-mode');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const logs: string[] = [];
    const of = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DECK_CONFIG_DIR: '/cfg', ...env }, home, '/repo', (l) => logs.push(l));
    expect(of()).toMatchObject({ usageMode: 'cli', claudeUsageFile: '/cfg/claude-usage-observed.json' });
    expect(of({ DECK_URL: 'http://deck:9310' }).usageMode).toBe('usage-deck');
    expect(of({ DECK_URL: 'http://deck:9310', DECK_USAGE_SOURCE: 'cli' }).usageMode).toBe('cli');
    expect(logs).toEqual([]);
    expect(of({ DECK_USAGE_SOURCE: 'nope' }).usageMode).toBe('cli');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('DECK_USAGE_SOURCE');
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://100.64.0.1:9310\n');
    expect(of().usageMode).toBe('usage-deck');
  });

  it('DECK_USAGE_SOURCE default: usage-deck at the default address that answered before (usage-source.json) stays usage-deck', () => {
    const home = path.join(dir, 'home-usage-seen');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-seen-'));
    const of = (env: NodeJS.ProcessEnv = {}) => loadConfig({ DECK_CONFIG_DIR: cfg, ...env }, home, '/repo', () => {});
    expect(of().usageMode).toBe('cli');
    fs.writeFileSync(path.join(cfg, 'usage-source.json'), '{');
    expect(readDeckSeen(path.join(cfg, 'usage-source.json'))).toBe(false);
    expect(of().usageMode).toBe('cli');
    fs.writeFileSync(path.join(cfg, 'usage-source.json'), JSON.stringify({ deckSeenAt: '2026-10-01T00:00:00.000Z' }));
    expect(readDeckSeen(path.join(cfg, 'usage-source.json'))).toBe(true);
    expect(of()).toMatchObject({ usageMode: 'usage-deck', deckUrlConfigured: false });
    expect(of({ DECK_USAGE_SOURCE: 'cli' }).usageMode).toBe('cli');
  });

  it('loadConfig derives paths from HOME and honours env overrides', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://deck:9310\n');
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), '# c\na\n');
    for (const p of ['.claude', '.claude-b', '.claude-c']) fs.mkdirSync(path.join(home, p, 'projects'), { recursive: true });
    const c = loadConfig({}, home, '/repo');
    expect(c).toMatchObject({
      configDir: path.join(home, '.config/deck'),
      tokenFile: path.join(home, '.config/deck/token'),
      pinnedFile: path.join(home, '.config/deck/projects.json'),
      stateFile: path.join(home, '.config/deck/session-state.json'),
      auditFile: path.join(home, '.config/deck/audit.log'),
      deckUrl: 'http://deck:9310',
      protectedAccount: 'a',
      cooldownDir: path.join(home, '.config/deck/cooldown'),
      port: 9320,
      loopbackOnly: false,
      devOrigins: [],
      uiDir: '/repo/dist/ui',
    });
    expect(c.accounts.list()).toEqual(['a', 'b', 'c']);
    expect(c.projectsRoots).toEqual([{ id: 'a', dir: path.join(home, '.claude/projects') }, { id: 'b', dir: path.join(home, '.claude-b/projects') }, { id: 'c', dir: path.join(home, '.claude-c/projects') }]);
    const o = loadConfig({ DECK_CONFIG_DIR: '/cfg', DECK_PORT: '9999', DECK_URL: 'http://x', CLAUDE_PROTECT: 'b', DECK_LOOPBACK_ONLY: '1', DECK_DEV_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173', DECK_UI_DIR: '/ui' }, home, '/repo');
    expect(o).toMatchObject({ configDir: '/cfg', tokenFile: '/cfg/token', port: 9999, deckUrl: 'http://x', protectedAccount: 'b', loopbackOnly: true, devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'], uiDir: '/ui' });
  });

  it('a protected account that is not configured is ignored with one warning (env and file)', () => {
    const home = path.join(dir, 'home2');
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-b', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), 'c\n');
    const logs: string[] = [];
    expect(loadConfig({}, home, '/repo', (l) => logs.push(l)).protectedAccount).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/보호 계정 "c".*설정에 없는/);
    logs.length = 0;
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), 'b\n');
    expect(loadConfig({ CLAUDE_PROTECT: 'zz' }, home, '/repo', (l) => logs.push(l)).protectedAccount).toBe('b');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('CLAUDE_PROTECT="zz"');
    logs.length = 0;
    expect(loadConfig({ CLAUDE_PROTECT: 'b' }, home, '/repo', (l) => logs.push(l)).protectedAccount).toBe('b');
    expect(logs).toEqual([]);
  });

  it('a broken accounts.json stops loadConfig (the server does not start on discovered accounts)', () => {
    const home = path.join(dir, 'home3');
    fs.mkdirSync(path.join(home, '.config', 'deck'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'deck', 'accounts.json'), '{');
    expect(() => loadConfig({}, home, '/repo', () => {})).toThrow(/accounts\.json 을 쓸 수 없어 시작하지 않습니다/);
  });

  it('codex bin, sessions root and attachments dir (D11)', () => {
    const cfg = loadConfig({ PATH: '/nonexistent', CODEX_HOME: '/h/.codex-alt' }, '/h', '/repo');
    expect(cfg.codexBin).toBeNull();
    expect(cfg.geminiBin).toBeNull();
    expect(cfg.codexSessionsRoot).toBe('/h/.codex-alt/sessions');
    expect(cfg.codexArchivedRoot).toBe('/h/.codex-alt/archived_sessions');
    expect(cfg.attachmentsDir).toBe('/h/.config/deck/attachments');
    expect(cfg.backupRetentionDays).toBe(30);
    expect(loadConfig({ PATH: '/nonexistent', DECK_BACKUP_RETENTION_DAYS: '7' }, '/h', '/repo').backupRetentionDays).toBe(7);
    expect(loadConfig({ PATH: '/nonexistent', DECK_BACKUP_RETENTION_DAYS: '-1' }, '/h', '/repo').backupRetentionDays).toBe(30);
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').codexSessionsRoot).toBe('/h/.codex/sessions');
  });

  it('claude bin: DECK_CLAUDE_BIN, version-gated by `claude --version`', () => {
    const script = path.join(dir, 'claude');
    fs.writeFileSync(script, '#!/bin/sh\necho "2.1.283 (Claude Code)"\n', { mode: 0o755 });
    expect(loadConfig({ PATH: '/nonexistent', DECK_CLAUDE_BIN: script }, '/h', '/repo').claudeBin).toEqual({ ok: true, bin: script, version: '2.1.283', belowRecommended: false });
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').claudeBin).toEqual({ ok: false, reason: 'missing' });
  });

  it('recent folders file and new-session cwd roots (F1)', () => {
    const cfg = loadConfig({ PATH: '/nonexistent' }, '/h', '/repo');
    expect(cfg.recentFoldersFile).toBe('/h/.config/deck/recent-folders.json');
    expect(cfg.pinsFile).toBe('/h/.config/deck/pins.json');
    expect(cfg.cwdRoots).toEqual(['/h']);
    expect(loadConfig({ PATH: '/nonexistent', DECK_LOOPBACK_ONLY: '1', DECK_EXTRA_CWD_ROOTS: '/tmp/x, /private/var/y' }, '/h', '/repo').cwdRoots).toEqual(['/h', '/tmp/x', '/private/var/y']);
  });

  it('DECK_EXTRA_CWD_ROOTS only counts with DECK_LOOPBACK_ONLY=1, and never / (review fix 2)', () => {
    expect(loadConfig({ PATH: '/nonexistent', DECK_EXTRA_CWD_ROOTS: '/tmp/x' }, '/h', '/repo').cwdRoots).toEqual(['/h']);
    expect(loadConfig({ PATH: '/nonexistent', DECK_LOOPBACK_ONLY: '1', DECK_EXTRA_CWD_ROOTS: '/, //, /./, /tmp/x, rel' }, '/h', '/repo').cwdRoots).toEqual(['/h', '/tmp/x']);
  });

  it('grok bin: DECK_GROK_BIN (only if executable) → PATH → <home>/.grok/bin/grok; grokHome is <home>/.grok resolved, never GROK_HOME', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-grok-'));
    const exe = (p: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };
    const home = path.join(t, 'home');
    const installed = exe(path.join(home, '.grok', 'bin', 'grok'));
    const onPath = exe(path.join(t, 'bin', 'grok'));
    const custom = exe(path.join(t, 'custom', 'grok-dev'));
    fs.writeFileSync(path.join(t, 'plain'), 'x');
    expect(resolveGrokBin({ DECK_GROK_BIN: custom, PATH: path.join(t, 'bin') }, home)).toBe(custom);
    expect(resolveGrokBin({ DECK_GROK_BIN: path.join(t, 'plain'), PATH: path.join(t, 'bin') }, home)).toBeNull();
    // A refused DECK_GROK_BIN (relative, or not executable) says why in one line naming only the path.
    const lines: string[] = [];
    expect(resolveGrokBin({ DECK_GROK_BIN: 'bin/grok', PATH: path.join(t, 'bin'), SECRET_TOKEN: 'abc' }, home, () => true, (l) => lines.push(l))).toBeNull();
    expect(resolveGrokBin({ DECK_GROK_BIN: path.join(t, 'plain'), PATH: path.join(t, 'bin') }, home, undefined, (l) => lines.push(l))).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"bin/grok"');
    expect(lines[0]).toContain('절대경로');
    expect(lines[1]).toContain(JSON.stringify(path.join(t, 'plain')));
    expect(lines.join('\n')).not.toMatch(/abc|SECRET_TOKEN|PATH/);
    expect(resolveGrokBin({ PATH: `${path.join(t, 'none')}:${path.join(t, 'bin')}` }, home)).toBe(onPath);
    expect(resolveGrokBin({ PATH: path.join(t, 'none') }, home)).toBe(installed);
    expect(resolveGrokBin({}, path.join(t, 'nohome'))).toBeNull();
    const cfg = loadConfig({ DECK_CONFIG_DIR: path.join(t, 'cfg'), PATH: path.join(t, 'none'), GROK_HOME: '/elsewhere' }, home, '/repo');
    expect(cfg.grokBin).toBe(installed);
    expect(cfg.grokHome).toBe(fs.realpathSync(path.join(home, '.grok')));
    fs.rmSync(t, { recursive: true, force: true });
  });
  const listFiles = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => !d.isDirectory()).map((d) => path.relative(root, path.join(d.parentPath, d.name))).sort();

  it('loadConfig writes nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-nowrite-'));
    loadConfig({ PATH: '' }, home, '/repo', () => {});
    expect(fs.readdirSync(home)).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loadConfig + writeCooldown on a fresh home write only under configDir; usage defaults to cli', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-fresh-'));
    const cfg = loadConfig({ PATH: '' }, home, '/repo', () => {});
    writeCooldown(cfg.cooldownDir, 'a', Date.now() + 60_000);
    const files = listFiles(home);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith(path.join('.config', 'deck') + path.sep))).toBe(true);
    expect(cfg.usageMode).toBe('cli');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a relative DECK_CONFIG_DIR is made absolute; <configDir>/protect is read before the offload file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-rel-'));
    for (const p of ['.claude', '.claude-b']) fs.mkdirSync(path.join(home, p, 'projects'), { recursive: true });
    expect(path.isAbsolute(loadConfig({ DECK_CONFIG_DIR: 'rel-cfg', PATH: '' }, home, '/repo', () => {}).configDir)).toBe(true);
    const cfgDir = path.join(home, 'cfg');
    fs.mkdirSync(cfgDir);
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), 'a\n');
    fs.writeFileSync(path.join(cfgDir, 'protect'), 'b\n');
    expect(loadConfig({ DECK_CONFIG_DIR: cfgDir, PATH: '' }, home, '/repo', () => {}).protectedAccount).toBe('b');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

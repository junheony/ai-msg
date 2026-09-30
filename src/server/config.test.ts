import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readDeckUrl, readProtect } from './config';

describe('config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cfg-'));

  it('readProtect skips comments/blank lines and validates', () => {
    const f = path.join(dir, 'protect');
    fs.writeFileSync(f, '# Desktop account\n\na\n');
    expect(readProtect(f)).toBe('a');
    fs.writeFileSync(f, 'z\n');
    expect(readProtect(f)).toBeNull();
    expect(readProtect(path.join(dir, 'missing'))).toBeNull();
  });

  it('readDeckUrl trims and falls back', () => {
    const f = path.join(dir, 'deck_url');
    fs.writeFileSync(f, 'http://100.125.168.94:9310  \n');
    expect(readDeckUrl(f)).toBe('http://100.125.168.94:9310');
    expect(readDeckUrl(path.join(dir, 'nope'))).toBe('http://127.0.0.1:9310');
  });

  it('loadConfig derives paths from HOME and honours env overrides', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.config', 'claude-pick'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'offload'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-pick', 'deck_url'), 'http://deck:9310\n');
    fs.writeFileSync(path.join(home, '.config', 'offload', 'protect'), '# c\na\n');
    const c = loadConfig({}, home, '/repo');
    expect(c).toMatchObject({
      configDir: path.join(home, '.config/deck'),
      tokenFile: path.join(home, '.config/deck/token'),
      pinnedFile: path.join(home, '.config/deck/projects.json'),
      stateFile: path.join(home, '.config/deck/session-state.json'),
      auditFile: path.join(home, '.config/deck/audit.log'),
      deckUrl: 'http://deck:9310',
      protectedAccount: 'a',
      cooldownDir: path.join(home, '.cache/offload/cooldown'),
      port: 9320,
      loopbackOnly: false,
      devOrigins: [],
      uiDir: '/repo/dist/ui',
    });
    expect(c.projectsRoots).toEqual({ a: path.join(home, '.claude/projects'), b: path.join(home, '.claude-b/projects'), c: path.join(home, '.claude-c/projects') });
    const o = loadConfig({ DECK_CONFIG_DIR: '/cfg', DECK_PORT: '9999', DECK_URL: 'http://x', CLAUDE_PROTECT: 'b', DECK_LOOPBACK_ONLY: '1', DECK_DEV_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173', DECK_UI_DIR: '/ui' }, home, '/repo');
    expect(o).toMatchObject({ configDir: '/cfg', tokenFile: '/cfg/token', port: 9999, deckUrl: 'http://x', protectedAccount: 'b', loopbackOnly: true, devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'], uiDir: '/ui' });
  });
});

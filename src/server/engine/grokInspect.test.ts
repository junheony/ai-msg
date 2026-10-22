import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGrokConfigToml, checkGrokInspect, grokInspectRefusal } from './grokInspect';

const FX = path.join(__dirname, 'acp', 'fixtures', 'grok-1.0.62');
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8')) as Record<string, unknown>;

/** config.toml as Grok's user layer, by the fixture's `<HOME>/.grok/config.toml` path. */
const reader = (files: Record<string, string>) => async (p: string) => {
  if (p in files) return files[p]!;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
const LAYER = '<HOME>/.grok/config.toml';
const PLAIN_TOML = '[cli]\ninstaller = "x"\n[marketplace]\nofficial_marketplace_auto_installed = true\n[[marketplace.sources]]\nname = "official"\n';

describe('checkGrokInspect (fixtures from grok 1.0.62)', () => {
  it('clean (shadow HOME): passes', async () => {
    expect(await checkGrokInspect(load('inspect.clean.json'), reader({ [LAYER]: PLAIN_TOML }))).toEqual({ ok: true });
    // No config file at all: still clean.
    expect(await checkGrokInspect(load('inspect.clean.json'), reader({}))).toEqual({ ok: true });
  });

  it('Claude rules (real HOME): refused, naming the source', async () => {
    const v = await checkGrokInspect(load('inspect.claude-rules.json'), reader({ [LAYER]: PLAIN_TOML }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.item).toContain('권한 규칙 출처 1개');
      expect(v.item).toContain('.claude/settings.local.json');
      expect(grokInspectRefusal(v.item)).toMatch(/^Grok 설정\(~\/\.grok\/config\.toml\)의 권한 기본값이 자동이라 AI-MSG 승인을 보장할 수 없음 — /);
    }
  });

  it('auto by default (config.toml permission_mode / auto_mode, or a defaultMode field): refused', async () => {
    for (const toml of ['[ui]\npermission_mode = "auto"\n', '[ui]\npermission_mode = "bypassPermissions"\n', '[auto_mode]\nenabled = true\n', 'auto_mode.enabled = true\n', '[ui]\nauto_mode = { enabled = true }\n', 'yolo = true\n']) {
      const v = await checkGrokInspect(load('inspect.clean.json'), reader({ [LAYER]: toml }));
      expect(v.ok, toml).toBe(false);
    }
    const withField = load('inspect.clean.json');
    (withField.permissions as Record<string, unknown>).defaultMode = 'auto';
    expect((await checkGrokInspect(withField, reader({}))).ok).toBe(false);
    (withField.permissions as Record<string, unknown>).defaultMode = 'default';
    expect((await checkGrokInspect(withField, reader({}))).ok).toBe(true);
  });

  it('explicitly safe values pass', async () => {
    for (const toml of ['[ui]\npermission_mode = "default"\n', '[auto_mode]\nenabled = false\n', '# permission_mode = "auto"\n']) {
      expect(await checkGrokInspect(load('inspect.clean.json'), reader({ [LAYER]: toml })), toml).toEqual({ ok: true });
    }
  });

  it('missing fields or an unreadable layer: fail-closed', async () => {
    const clean = load('inspect.clean.json');
    const without = (f: (j: Record<string, unknown>) => void) => { const j = structuredClone(clean); f(j); return j; };
    for (const j of [
      null, 'x', {},
      without((j) => { delete j.permissions; }),
      without((j) => { delete (j.permissions as Record<string, unknown>).sources; }),
      without((j) => { delete (j.permissions as Record<string, unknown>).loaded; }),
      without((j) => { delete j.configSources; }),
      without((j) => { j.configSources = { layers: [{ role: 'user' }] }; }),
    ]) {
      expect((await checkGrokInspect(j, reader({}))).ok, JSON.stringify(j)?.slice(0, 80)).toBe(false);
    }
    const eacces = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    expect((await checkGrokInspect(clean, eacces)).ok).toBe(false);
  });
});

describe('checkGrokInspect: hooks, MCP, plugins, external compat (§14.9-2)', () => {
  const clean = load('inspect.clean.json');
  const edit = (f: (j: Record<string, unknown>) => void) => { const j = structuredClone(clean); f(j); return j; };
  type Cell = { vendor: string; surface: string; enabled: boolean; source: string };
  const cells = (j: Record<string, unknown>) => (j.externalCompat as { cells: Cell[] }).cells;
  const cell = (j: Record<string, unknown>, vendor: string, surface: string) => cells(j).find((c) => c.vendor === vendor && c.surface === surface)!;

  it('hooks / mcpServers / plugins: non-empty, not an array, or missing → refused', async () => {
    for (const k of ['hooks', 'mcpServers', 'plugins']) {
      for (const j of [
        edit((j) => { j[k] = [{ name: 'x', command: 'touch /tmp/p' }]; }),
        edit((j) => { j[k] = { x: 1 }; }),
        edit((j) => { j[k] = null; }),
        edit((j) => { delete j[k]; }),
      ]) {
        expect((await checkGrokInspect(j, reader({}))).ok, `${k}: ${JSON.stringify(j[k])}`).toBe(false);
      }
    }
  });

  it('externalCompat: missing, cells not an array, or remote settings loaded → refused', async () => {
    for (const j of [
      edit((j) => { delete j.externalCompat; }),
      edit((j) => { (j.externalCompat as Record<string, unknown>).cells = {}; }),
      edit((j) => { delete (j.externalCompat as Record<string, unknown>).cells; }),
      edit((j) => { (j.externalCompat as Record<string, unknown>).remoteSettingsLoaded = true; }),
      edit((j) => { delete (j.externalCompat as Record<string, unknown>).remoteSettingsLoaded; }),
    ]) {
      expect((await checkGrokInspect(j, reader({}))).ok).toBe(false);
    }
  });

  it('Claude hooks / MCP cells on (deck turns them off by env, so on = the env did not take) → refused', async () => {
    for (const s of ['hooks', 'mcps']) {
      const j = edit((j) => { Object.assign(cell(j, 'claude', s), { enabled: true, source: 'default' }); });
      expect((await checkGrokInspect(j, reader({}))).ok, s).toBe(false);
    }
  });

  it('Cursor hooks / MCP cells: on by default passes (no ~/.cursor in the shadow HOME, project .cursor/ blocked); switched on by config/env/remote → refused', async () => {
    expect(cell(clean, 'cursor', 'hooks')).toMatchObject({ enabled: true, source: 'default' });
    expect(await checkGrokInspect(clean, reader({}))).toEqual({ ok: true });
    for (const s of ['hooks', 'mcps']) {
      for (const source of ['config', 'env', 'remote', 'project', undefined]) {
        const j = edit((j) => { const c = cell(j, 'cursor', s) as Record<string, unknown>; if (source === undefined) delete c.source; else c.source = source; });
        expect((await checkGrokInspect(j, reader({}))).ok, `${s} ${source}`).toBe(false);
      }
    }
    // A vendor deck does not know with hooks or MCP on, or a cell it cannot read: refused.
    expect((await checkGrokInspect(edit((j) => { cells(j).push({ vendor: 'windsurf', surface: 'hooks', enabled: true, source: 'default' }); }), reader({}))).ok).toBe(false);
    expect((await checkGrokInspect(edit((j) => { (cells(j) as unknown[]).push('x'); }), reader({}))).ok).toBe(false);
    expect((await checkGrokInspect(edit((j) => { Object.assign(cell(j, 'cursor', 'mcps'), { enabled: 'yes' }); }), reader({}))).ok).toBe(false);
  });

  it('Cursor rules: judged like other rules (permissions.sources / loaded), so on by default passes', async () => {
    expect(cell(clean, 'cursor', 'rules').enabled).toBe(true);
    expect(await checkGrokInspect(edit((j) => { cell(j, 'cursor', 'rules').source = 'config'; }), reader({}))).toEqual({ ok: true });
  });

  it('no config layer at all, or managed settings active → refused', async () => {
    expect((await checkGrokInspect(edit((j) => { j.configSources = { layers: [] }; }), reader({}))).ok).toBe(false);
    expect((await checkGrokInspect(edit((j) => { (j.permissions as Record<string, unknown>).managedSettingsActive = true; }), reader({}))).ok).toBe(false);
    expect((await checkGrokInspect(edit((j) => { delete (j.permissions as Record<string, unknown>).managedSettingsActive; }), reader({}))).ok).toBe(false);
  });
});

describe('checkGrokConfigToml', () => {
  it('ignores unrelated keys and comments', () => {
    expect(checkGrokConfigToml(PLAIN_TOML)).toEqual({ ok: true });
    expect(checkGrokConfigToml('name = "a # permission_mode = auto"\n')).toEqual({ ok: true });
  });

  it('inline tables are read inside: an auto value there is refused; safe ones pass', () => {
    for (const toml of [
      'ui = { permission_mode = "auto" }\n',
      '[x]\nui = { theme = "dark", permission_mode = "bypassPermissions" }\n',
      'ui = { inner = { permission_mode = "auto" } }\n',
      'ui = { "permission_mode" = "auto" }\n',
      'ui = { auto_mode = { enabled = true } }\n',
      'auto_mode = { enabled = true }\n',
      'ui = { yolo = true }\n',
    ]) {
      expect(checkGrokConfigToml(toml).ok, toml).toBe(false);
    }
    for (const toml of ['ui = { permission_mode = "default", theme = "a,b}" }\n', 'auto_mode = { enabled = false }\n', 'ui = {}\n']) {
      expect(checkGrokConfigToml(toml), toml).toEqual({ ok: true });
    }
  });

  it('an inline table it cannot read → refused', () => {
    for (const toml of ['ui = { permission_mode = "auto"\n', 'ui = { a = 1 } trailing\n', 'ui = { a = "x }\n', 'ui = { justakey }\n']) {
      expect(checkGrokConfigToml(toml).ok, toml).toBe(false);
    }
  });
});

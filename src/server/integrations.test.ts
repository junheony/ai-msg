import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyIntegrations } from './integrations';

describe('legacyIntegrations', () => {
  let home: string;
  let cfgDir: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-integ-'));
    cfgDir = path.join(home, '.config', 'deck');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('fresh home: no personal-tool paths, cooldown under configDir', () => {
    expect(legacyIntegrations({}, home, cfgDir)).toEqual({ deckUrlFile: null, protectFile: null, cooldownDir: path.join(cfgDir, 'cooldown') });
  });
  it('the claude-pick deck_url file counts only when it exists', () => {
    const f = path.join(home, '.config', 'claude-pick', 'deck_url');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'http://x:9310\n');
    expect(legacyIntegrations({}, home, cfgDir).deckUrlFile).toBe(f);
  });
  it('an existing offload cooldown dir is still shared', () => {
    fs.mkdirSync(path.join(home, '.cache', 'offload', 'cooldown'), { recursive: true });
    expect(legacyIntegrations({}, home, cfgDir).cooldownDir).toBe(path.join(home, '.cache', 'offload', 'cooldown'));
  });
  it('XDG_CACHE_HOME set but only ~/.cache/offload/cooldown exists: still shared', () => {
    fs.mkdirSync(path.join(home, '.cache', 'offload', 'cooldown'), { recursive: true });
    expect(legacyIntegrations({ XDG_CACHE_HOME: path.join(home, 'xc') }, home, cfgDir).cooldownDir).toBe(path.join(home, '.cache', 'offload', 'cooldown'));
  });
  it('an existing XDG_CACHE_HOME cooldown dir wins over ~/.cache', () => {
    fs.mkdirSync(path.join(home, '.cache', 'offload', 'cooldown'), { recursive: true });
    fs.mkdirSync(path.join(home, 'xc', 'offload', 'cooldown'), { recursive: true });
    expect(legacyIntegrations({ XDG_CACHE_HOME: path.join(home, 'xc') }, home, cfgDir).cooldownDir).toBe(path.join(home, 'xc', 'offload', 'cooldown'));
  });
  it('a relative XDG_CACHE_HOME is ignored', () =>
    expect(legacyIntegrations({ XDG_CACHE_HOME: 'xc' }, home, cfgDir, () => true).cooldownDir).toBe(path.join(home, '.cache', 'offload', 'cooldown')));
  it('CLAUDE_PICK_COOLDOWN_DIR wins even when missing', () =>
    expect(legacyIntegrations({ CLAUDE_PICK_COOLDOWN_DIR: '/c' }, home, cfgDir).cooldownDir).toBe('/c'));
  it('<configDir>/protect before ~/.config/offload/protect', () => {
    const legacy = path.join(home, '.config', 'offload', 'protect');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'a\n');
    expect(legacyIntegrations({}, home, cfgDir).protectFile).toBe(legacy);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'protect'), 'b\n');
    expect(legacyIntegrations({}, home, cfgDir).protectFile).toBe(path.join(cfgDir, 'protect'));
  });
});

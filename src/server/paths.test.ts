import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir } from './paths';

describe('resolveConfigDir', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-paths-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('DECK_CONFIG_DIR wins', () => expect(resolveConfigDir({ DECK_CONFIG_DIR: '/x' }, home, { exists: () => true })).toBe('/x'));
  it('relative DECK_CONFIG_DIR is made absolute against cwd; ~/ expands', () => {
    expect(resolveConfigDir({ DECK_CONFIG_DIR: 'rel/d' }, home, { cwd: '/w' })).toBe('/w/rel/d');
    expect(resolveConfigDir({ DECK_CONFIG_DIR: '~/d' }, home)).toBe(path.join(home, 'd'));
  });
  it('legacy ~/.config/deck wins over XDG_CONFIG_HOME', () => {
    fs.mkdirSync(path.join(home, '.config', 'deck'), { recursive: true });
    expect(resolveConfigDir({ XDG_CONFIG_HOME: path.join(home, 'xdg') }, home)).toBe(path.join(home, '.config', 'deck'));
  });
  it('XDG_CONFIG_HOME without a legacy dir', () =>
    expect(resolveConfigDir({ XDG_CONFIG_HOME: path.join(home, 'xdg') }, home)).toBe(path.join(home, 'xdg', 'deck')));
  it('a relative XDG_CONFIG_HOME is ignored', () =>
    expect(resolveConfigDir({ XDG_CONFIG_HOME: 'xdg' }, home)).toBe(path.join(home, '.config', 'deck')));
  it('nothing set, nothing there: <home>/.config/deck', () =>
    expect(resolveConfigDir({}, home)).toBe(path.join(home, '.config', 'deck')));
});

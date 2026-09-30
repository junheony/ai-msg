import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCooldownDir, readAllCooldownsMs, readCooldownUntilMs, writeCooldown } from './cooldown';

describe('cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cd-'));
  const now = 1_790_000_000_000;

  it('resolves the directory the way claude-pick does', () => {
    expect(defaultCooldownDir({ CLAUDE_PICK_COOLDOWN_DIR: '/x/cd' }, '/h')).toBe('/x/cd');
    expect(defaultCooldownDir({ XDG_CACHE_HOME: '/xdg' }, '/h')).toBe('/xdg/offload/cooldown');
    expect(defaultCooldownDir({}, '/h')).toBe('/h/.cache/offload/cooldown');
  });

  it('writes epoch seconds and reads back milliseconds; expired or missing → null', () => {
    writeCooldown(dir, 'b', now + 3_600_000);
    expect(fs.readFileSync(path.join(dir, 'b'), 'utf8').trim()).toBe(String(Math.floor((now + 3_600_000) / 1000)));
    expect(readCooldownUntilMs(dir, 'b', now)).toBe(Math.floor((now + 3_600_000) / 1000) * 1000);
    expect(readCooldownUntilMs(dir, 'b', now + 3_600_001)).toBeNull();
    expect(readCooldownUntilMs(dir, 'a', now)).toBeNull();
  });

  it('accepts the float format offload writes and ignores garbage', () => {
    fs.writeFileSync(path.join(dir, 'c'), `${(now + 5000) / 1000}\n`);
    expect(readCooldownUntilMs(dir, 'c', now)).toBe(now + 5000);
    fs.writeFileSync(path.join(dir, 'a'), 'soon\n');
    expect(readCooldownUntilMs(dir, 'a', now)).toBeNull();
    expect(readAllCooldownsMs(dir, now)).toEqual({ b: Math.floor((now + 3_600_000) / 1000) * 1000, c: now + 5000 });
  });

  it('creates the directory on write', () => {
    const fresh = path.join(dir, 'nested', 'cooldown');
    writeCooldown(fresh, 'a', now + 1000);
    expect(readCooldownUntilMs(fresh, 'a', now)).toBe(now + 1000);
  });
});

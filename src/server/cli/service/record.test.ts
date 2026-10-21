import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANAGED_MARKER, buildServiceRecord, readServiceRecord, writeServiceRecord } from './record';

const base = { platform: 'linux' as const, home: '/h', configDir: '/h/.config/deck/../deck', port: 9400, node: '/usr/bin/node', bin: '/g/bin.js', cliBins: { DECK_CLAUDE_BIN: '/h/.local/bin/claude' }, packageVersion: '0.1.0', now: () => new Date(0) };

describe('service record', () => {
  it('record: resolved absolute paths, no supervisor vars, drain clamped', () => {
    const env = { PATH: '/usr/bin', LANG: 'ko_KR.UTF-8', LC_ALL: 'C', DECK_SUPERVISED: '1', DECK_SUPERVISOR: 'launchd', DECK_ENV_FILE: '/x', DECK_LOOPBACK_ONLY: '1', XDG_CONFIG_HOME: '/h/.xdg', SECRET: 's', DECK_DRAIN_MAX_MIN: 'Infinity' };
    const { record, warnings } = buildServiceRecord({ ...base, env });
    expect(record.configDir).toBe('/h/.config/deck');
    expect(record.env).toEqual({
      PATH: '/usr/bin', HOME: '/h', LANG: 'ko_KR.UTF-8', LC_ALL: 'C', DECK_LOOPBACK_ONLY: '1', XDG_CONFIG_HOME: '/h/.xdg',
      DECK_CLAUDE_BIN: '/h/.local/bin/claude', DECK_CONFIG_DIR: '/h/.config/deck', DECK_PORT: '9400', DECK_DRAIN_MAX_MIN: '25',
    });
    expect(record.drainMaxMin).toBe(25);
    expect(warnings).toHaveLength(1);
    expect(buildServiceRecord({ ...base, env: { DECK_DRAIN_MAX_MIN: '10' } }).record.drainMaxMin).toBe(10);
    expect(buildServiceRecord({ ...base, env: { DECK_DRAIN_MAX_MIN: '10' }, drainFlag: 3 }).record.drainMaxMin).toBe(3);
    expect(buildServiceRecord({ ...base, env: { DECK_DRAIN_MAX_MIN: '29' } }).warnings).toHaveLength(1);
  });

  it('writes service.json and service.env 0600 with the marker; reads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rec-'));
    try {
      const { record } = buildServiceRecord({ ...base, configDir: dir, env: { PATH: '/a b:$HOME' } });
      writeServiceRecord(dir, record);
      const envText = fs.readFileSync(path.join(dir, 'service.env'), 'utf8');
      expect(envText.split('\n')[0]).toContain(MANAGED_MARKER);
      expect(envText).toContain('PATH="/a b:\\$HOME"');
      expect(fs.statSync(path.join(dir, 'service.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'service.env')).mode & 0o777).toBe(0o600);
      expect(readServiceRecord(dir)).toEqual(record);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

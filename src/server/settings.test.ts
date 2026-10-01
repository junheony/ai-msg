import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from './settings';

describe('SettingsStore', () => {
  it('defaults to 자동 승인 on; persists a change; a corrupt file falls back to defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'sub', 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: true });
    expect(await s.set({ autoApprove: false })).toEqual({ autoApprove: false });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoApprove: false });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().autoApprove).toBe(false);
    await fs.writeFile(file, '{oops');
    await again.load();
    expect(again.get().autoApprove).toBe(true);
  });
});

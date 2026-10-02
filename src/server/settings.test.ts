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
    expect(s.get()).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions' });
    expect(await s.set({ autoApprove: false })).toEqual({ autoApprove: false, defaultPermissionMode: 'default' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoApprove: false, defaultPermissionMode: 'default' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().autoApprove).toBe(false);
    await fs.writeFile(file, '{oops');
    await again.load();
    expect(again.get().autoApprove).toBe(true);
  });

  it('migrates a legacy autoApprove-only file; defaultPermissionMode wins and keeps autoApprove in step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ autoApprove: false }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default' });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true }));
    await s.load();
    expect(s.get().defaultPermissionMode).toBe('bypassPermissions');
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan' });
    expect(await s.set({ defaultPermissionMode: 'bypassPermissions' })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions' });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true, defaultPermissionMode: 'acceptEdits' }));
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'acceptEdits' });
  });
});

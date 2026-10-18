import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from './settings';

/** 자동 분배 defaults: every engine, no external-transfer consent, Grok 4.7 (not Fast). */
const AUTO = { autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: [], grokFast: false };

describe('SettingsStore', () => {
  it('defaults to asking (자동 승인 off); persists a change; a corrupt file falls back to defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'sub', 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    expect(await s.set({ autoApprove: true })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().autoApprove).toBe(true);
    await fs.writeFile(file, '{oops');
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
  });

  it('an existing settings.json wins over the defaults: an install that chose 모두 자동 승인 keeps it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    for (const saved of [
      { autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000 },
      { autoApprove: true, defaultPermissionMode: 'bypassPermissions' },
      { defaultPermissionMode: 'bypassPermissions' },
      { autoApprove: true },
    ]) {
      await fs.writeFile(file, JSON.stringify(saved));
      const s = new SettingsStore(file);
      await s.load();
      expect(s.get()).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    }
    // Only the fields the file lacks come from the defaults.
    await fs.writeFile(file, JSON.stringify({ routingPolicy: 'drain' }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
  });

  it('migrates a legacy autoApprove-only file; defaultPermissionMode wins and keeps autoApprove in step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ autoApprove: false }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true }));
    await s.load();
    expect(s.get().defaultPermissionMode).toBe('bypassPermissions');
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    expect(await s.set({ defaultPermissionMode: 'bypassPermissions' })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance' }));
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
  });

  it('routingPolicy: defaults to balance, round-trips drain through the file, ignores junk, survives other changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get().routingPolicy).toBe('balance');
    expect(await s.set({ routingPolicy: 'drain' })).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).routingPolicy).toBe('drain');
    // Another setting changed later keeps the policy.
    expect((await s.set({ defaultPermissionMode: 'plan' })).routingPolicy).toBe('drain');
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    // And the policy change keeps the permission mode.
    expect(await again.set({ routingPolicy: 'balance' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    await fs.writeFile(file, JSON.stringify({ defaultPermissionMode: 'plan', routingPolicy: 'spread-evenly' }));
    await again.load();
    expect(again.get().routingPolicy).toBe('balance');
  });

  it('sameVendorRotation: off by default and for a file without it; on round-trips through the file, junk is off, other changes keep it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get().sameVendorRotation).toBe(false);
    await fs.writeFile(file, JSON.stringify({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain' }));
    await s.load();
    expect(s.get().sameVendorRotation).toBe(false);
    expect((await s.set({ sameVendorRotation: true, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000 })).sameVendorRotation).toBe(true);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).sameVendorRotation).toBe(true);
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain', sameVendorRotation: true, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...AUTO });
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().sameVendorRotation).toBe(true);
    expect((await again.set({ sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000 })).sameVendorRotation).toBe(false);
    await fs.writeFile(file, JSON.stringify({ sameVendorRotation: 'yes' }));
    await again.load();
    expect(again.get().sameVendorRotation).toBe(false);
  });

  it('commanderEnabled: the settings screen toggle changes it; other changes keep it and the file-only limits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ commanderMaxTurns: 30 }));
    const s = new SettingsStore(file);
    await s.load();
    expect((await s.set({ commanderEnabled: true })).commanderEnabled).toBe(true);
    expect(await s.set({ routingPolicy: 'drain' })).toMatchObject({ commanderEnabled: true, commanderMaxTurns: 30 });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ commanderEnabled: true, commanderMaxTurns: 30 });
    expect((await s.set({ commanderEnabled: false })).commanderEnabled).toBe(false);
  });

  it('자동 분배: defaults, file validation (unknown engines dropped, malformed = default), set patch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toMatchObject(AUTO);
    await fs.writeFile(file, JSON.stringify({ autoEngines: ['grok', 'nope', 'claude', 'claude'], autoConsent: ['gemini', 7], grokFast: 'yes' }));
    await s.load();
    expect(s.get()).toMatchObject({ autoEngines: ['claude', 'grok'], autoConsent: ['gemini'], grokFast: false });
    await fs.writeFile(file, JSON.stringify({ autoEngines: 'all', autoConsent: null, grokFast: true }));
    await s.load();
    expect(s.get()).toMatchObject({ ...AUTO, grokFast: true });
    const next = await s.set({ autoEngines: ['codex', 'claude'], autoConsent: ['grok'] });
    expect(next).toMatchObject({ autoEngines: ['claude', 'codex'], autoConsent: ['grok'], grokFast: true });
    expect(await s.set({ grokFast: false })).toMatchObject({ autoEngines: ['claude', 'codex'], autoConsent: ['grok'], grokFast: false });
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get()).toMatchObject({ autoEngines: ['claude', 'codex'], autoConsent: ['grok'], grokFast: false });
  });
});

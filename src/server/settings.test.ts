import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from './settings';
import { resolveServerLocale } from './i18n';

/** 자동 분배 defaults: every engine, no external-transfer consent, Grok 4.7 (not Fast). */
const AUTO = { autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: [], grokFast: false, taskSoftCap: 3 };
/** 실험적 기능 on a fresh install (Grok Bot / Desktop off, Codex·Gemini imports on) and on one from before the switches (all on). */
const FRESH = { ...AUTO, experimental: { grokBot: false, desktop: false, localImports: true } };
const LEGACY = { ...AUTO, experimental: { grokBot: true, desktop: true, localImports: true } };

describe('SettingsStore', () => {
  it('defaults to asking (자동 승인 off); persists a change; a corrupt file falls back to defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'sub', 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
    expect(await s.set({ autoApprove: true })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().autoApprove).toBe(true);
    await fs.writeFile(file, '{oops');
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
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
      expect(s.get()).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
    }
    // Only the fields the file lacks come from the defaults.
    await fs.writeFile(file, JSON.stringify({ routingPolicy: 'drain' }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
  });

  it('migrates a legacy autoApprove-only file; defaultPermissionMode wins and keeps autoApprove in step', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ autoApprove: false }));
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true }));
    await s.load();
    expect(s.get().defaultPermissionMode).toBe('bypassPermissions');
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
    expect(await s.set({ defaultPermissionMode: 'bypassPermissions' })).toEqual({ autoApprove: true, defaultPermissionMode: 'bypassPermissions', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
    await fs.writeFile(file, JSON.stringify({ autoApprove: true, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance' }));
    await s.load();
    expect(s.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'acceptEdits', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
  });

  it('routingPolicy: defaults to balance, round-trips drain through the file, ignores junk, survives other changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get().routingPolicy).toBe('balance');
    expect(await s.set({ routingPolicy: 'drain' })).toEqual({ autoApprove: false, defaultPermissionMode: 'default', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).routingPolicy).toBe('drain');
    // Another setting changed later keeps the policy.
    expect((await s.set({ defaultPermissionMode: 'plan' })).routingPolicy).toBe('drain');
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get()).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
    // And the policy change keeps the permission mode.
    expect(await again.set({ routingPolicy: 'balance' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'balance', sameVendorRotation: false, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...FRESH });
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
    expect(await s.set({ defaultPermissionMode: 'plan' })).toEqual({ autoApprove: false, defaultPermissionMode: 'plan', routingPolicy: 'drain', sameVendorRotation: true, commanderEnabled: false, commanderMaxTurns: 20, commanderTokenCap: 2_000_000, ...LEGACY });
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

  it('실험적 기능 migration: fresh install off, older file or existing deck state on; decided once and written back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    // Fresh: no file, no deck state → Grok Bot / Desktop off, imports on; the decision is written at once.
    const fresh = path.join(dir, 'fresh.json');
    const a = new SettingsStore(fresh, async () => false);
    await a.load();
    expect(a.get().experimental).toEqual(FRESH.experimental);
    expect(JSON.parse(await fs.readFile(fresh, 'utf8')).experimental).toEqual(FRESH.experimental);
    // Later the deck state appears (first turn): the written decision holds.
    const a2 = new SettingsStore(fresh, async () => true);
    await a2.load();
    expect(a2.get().experimental).toEqual(FRESH.experimental);
    // An install that never opened 설정 but has deck's session state: everything stays on.
    const noFile = path.join(dir, 'nofile.json');
    const b = new SettingsStore(noFile, async () => true);
    await b.load();
    expect(b.get().experimental).toEqual(LEGACY.experimental);
    // A settings.json an older deck wrote (no experimental): on, kept with the user's other choices.
    const older = path.join(dir, 'older.json');
    await fs.writeFile(older, JSON.stringify({ sameVendorRotation: true, routingPolicy: 'drain' }));
    const c = new SettingsStore(older);
    await c.load();
    expect(c.get()).toMatchObject({ sameVendorRotation: true, routingPolicy: 'drain', experimental: LEGACY.experimental });
    expect(JSON.parse(await fs.readFile(older, 'utf8'))).toMatchObject({ sameVendorRotation: true, experimental: LEGACY.experimental });
    // A partial / junk experimental object: booleans kept, the rest from the fresh defaults (it was decided already).
    await fs.writeFile(older, JSON.stringify({ experimental: { grokBot: true, desktop: 'yes' } }));
    await c.load();
    expect(c.get().experimental).toEqual({ grokBot: true, desktop: false, localImports: true });
    // A corrupt file is not overwritten at load.
    await fs.writeFile(older, '{oops');
    await c.load();
    expect(await fs.readFile(older, 'utf8')).toBe('{oops');
    expect(c.get().experimental).toEqual(FRESH.experimental);
  });

  it('실험적 기능 migration that cannot be saved: this run uses the fresh-install switches, other settings untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    // The settings dir cannot be made (a file is in the way): the write fails.
    await fs.writeFile(path.join(dir, 'blocker'), '');
    const s = new SettingsStore(path.join(dir, 'blocker', 'settings.json'), async () => true);
    await s.load();
    expect(s.get().experimental).toEqual(FRESH.experimental);
    expect(s.get().routingPolicy).toBe('balance');
  });

  it('실험적 기능 set: only the given switches change, others and the other settings are kept', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect((await s.set({ experimental: { grokBot: true } })).experimental).toEqual({ grokBot: true, desktop: false, localImports: true });
    expect((await s.set({ experimental: { localImports: false } })).experimental).toEqual({ grokBot: true, desktop: false, localImports: false });
    expect((await s.set({ routingPolicy: 'drain' })).experimental).toEqual({ grokBot: true, desktop: false, localImports: false });
    const again = new SettingsStore(file, async () => true);
    await again.load();
    expect(again.get().experimental).toEqual({ grokBot: true, desktop: false, localImports: false });
  });
});

describe('SettingsStore language', () => {
  it('language: absent by default, persisted when set, invalid value ignored, null clears', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-set-'));
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore(file);
    await s.load();
    expect(s.get().language).toBeUndefined();
    expect((await s.set({ language: 'en' })).language).toBe('en');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).language).toBe('en');
    expect((await s.set({ routingPolicy: 'drain' })).language).toBe('en');
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get().language).toBe('en');
    await fs.writeFile(file, JSON.stringify({ language: 'fr' }));
    await again.load();
    expect(again.get().language).toBeUndefined();
    await again.set({ language: 'ko' });
    expect((await again.set({ language: null })).language).toBeUndefined();
  });

  it('resolveServerLocale: explicit setting wins over env', () => {
    expect(resolveServerLocale({ language: null }, { LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(resolveServerLocale({}, { LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveServerLocale({ language: 'en' }, { LANG: 'ko_KR.UTF-8' })).toBe('en');
  });
});

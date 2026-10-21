import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SetupStore, existingInstall } from './SetupStore';

let dir: string;
let file: string;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-setup-store-'));
  file = path.join(dir, 'setup.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('SetupStore', () => {
  it('SetupStore: an existing install is marked done without showing the wizard', async () => {
    const s = await SetupStore.open(file, { existingInstall: true });
    expect(s.needed()).toBe(false);
    expect(read()).toMatchObject({ state: 'done', migrated: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('SetupStore: a fresh install writes pending at once and survives a restart', async () => {
    const s = await SetupStore.open(file, { existingInstall: false });
    expect(s.needed()).toBe(true);
    expect(read()).toMatchObject({ state: 'pending' });
    const again = await SetupStore.open(file, { existingInstall: true }); // 재시작 때는 다른 데이터가 생겼어도
    expect(again.needed()).toBe(true);
  });

  it('markDone records done and is remembered', async () => {
    const s = await SetupStore.open(file, { existingInstall: false });
    await s.markDone();
    expect(s.needed()).toBe(false);
    expect(read()).toMatchObject({ state: 'done' });
    expect(read().migrated).toBeUndefined();
    expect((await SetupStore.open(file, { existingInstall: false })).needed()).toBe(false);
  });

  it('a broken file is pending and left as it is until markDone', async () => {
    fs.writeFileSync(file, '{ broken');
    const s = await SetupStore.open(file, { existingInstall: true });
    expect(s.needed()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
    await s.markDone();
    expect(read()).toMatchObject({ state: 'done' });
  });
});

describe('existingInstall', () => {
  it('existingInstall: an empty file is nothing; data is an install', () => {
    fs.writeFileSync(path.join(dir, 'token'), '');
    expect(existingInstall(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'session-meta.json'), '');
    expect(existingInstall(dir)).toBe(false); // empty is nothing
    fs.writeFileSync(path.join(dir, 'session-meta.json'), '{}');
    expect(existingInstall(dir)).toBe(true);
  });

  it('a missing config dir is no install', () => {
    expect(existingInstall(path.join(dir, 'nope'))).toBe(false);
  });

  it.each(['token', 'settings.json', 'vapid.json', 'session-state.json', 'activity.json', 'pins.json', 'projects.json', 'push-subscriptions.json', 'accounts.json'])('%s counts', (name) => {
    fs.writeFileSync(path.join(dir, name), '[]');
    expect(existingInstall(dir)).toBe(true);
  });

  it('a previous-version install (token only, no setup.json) is marked done, not shown the wizard', async () => {
    fs.writeFileSync(path.join(dir, 'token'), 'f'.repeat(64));
    const s = await SetupStore.open(file, { existingInstall: existingInstall(dir) });
    expect(s.needed()).toBe(false);
    expect(read()).toMatchObject({ state: 'done', migrated: true });
  });

  it('a fresh start writes pending before the token, so a restart before the wizard still shows it', async () => {
    const first = await SetupStore.open(file, { existingInstall: existingInstall(dir) });
    expect(first.needed()).toBe(true);
    fs.writeFileSync(path.join(dir, 'token'), 'f'.repeat(64)); // created after setup.json on that first start
    const again = await SetupStore.open(file, { existingInstall: existingInstall(dir) });
    expect(again.needed()).toBe(true);
  });
});

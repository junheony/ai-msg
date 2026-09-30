import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStateStore } from './SessionState';

describe('SessionStateStore', () => {
  it('persists and reloads states; missing file is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    await s.set({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    const s2 = new SessionStateStore(file);
    await s2.load();
    expect(s2.get('x')).toEqual({ sessionId: 'x', cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 5, justCompacted: false, defaultModel: 'opus' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('concurrent set() calls on different sessions all persist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    const s = new SessionStateStore(file);
    await s.load();
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => s.set({ sessionId: id, cwd: '/w', account: 'b', projectDir: '/p', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'opus' })));
    const s2 = new SessionStateStore(file);
    await s2.load();
    for (const id of ids) expect(s2.get(id)?.sessionId).toBe(id);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a corrupt file is preserved as .bad-<ts> and the store starts empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-st-'));
    const file = path.join(dir, 'session-state.json');
    await fs.writeFile(file, '{"x": {"sessionId": "x", tru');
    const s = new SessionStateStore(file);
    await s.load();
    expect(s.get('x')).toBeNull();
    const bad = (await fs.readdir(dir)).filter((f) => f.startsWith('session-state.json.bad-'));
    expect(bad).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, bad[0]!), 'utf8')).toBe('{"x": {"sessionId": "x", tru');
  });
});

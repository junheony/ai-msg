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
});

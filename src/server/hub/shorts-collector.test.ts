// The collector is Python (scripts/shorts-factory/collect_youtube.py); its offline unit tests run here so `npm test` covers it.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const TEST = 'scripts/shorts-factory/test_collect_youtube.py';
const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = py.status === 0;

describe('collect_youtube.py', () => {
  it.skipIf(!hasPython)('offline unit tests pass (fake yt-dlp runner, no network, no sleep)', () => {
    const r = spawnSync('python3', ['-I', '-B', TEST], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr + r.stdout, r.stderr).toMatch(/^OK/m);
    expect(r.status).toBe(0);
  }, 70_000);
});

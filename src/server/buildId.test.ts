import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBuildId } from './buildId';

describe('computeBuildId', () => {
  it('hashes index.html, changes with its content, and is null without a build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-build-'));
    expect(computeBuildId(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/a.js">');
    const a = computeBuildId(dir);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBuildId(dir)).toBe(a);
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/b.js">');
    expect(computeBuildId(dir)).not.toBe(a);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childScript, snapshotChildScripts } from './childScripts';

describe('childScript', () => {
  it('prefers the bundled .js', () => expect(childScript('hookRelay', '/p', (f) => f === '/p/hookRelay.js' || f === '/p/hookRelay.ts')).toBe('/p/hookRelay.js'));
  it('falls back to the .ts source', () => expect(childScript('permissionMcp', '/s', (f) => f === '/s/permissionMcp.ts')).toBe('/s/permissionMcp.ts'));
  it('throws when neither exists', () => expect(() => childScript('hookRelay', '/n', () => false)).toThrow());
  it('resolves the real source files in this checkout', () => {
    expect(fs.existsSync(childScript('hookRelay'))).toBe(true);
    expect(childScript('permissionMcp').endsWith('permissionMcp.ts')).toBe(true);
  });
});

describe('snapshotChildScripts', () => {
  it('a bundled run copies both scripts to run/<version>-<hash8>/, reuses it, and removes other snapshot folders only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-snap-'));
    try {
      const src = path.join(root, 'dist');
      const runDir = path.join(root, 'run');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'hookRelay.js'), 'a');
      fs.writeFileSync(path.join(src, 'permissionMcp.js'), 'b');
      fs.mkdirSync(path.join(runDir, '0.0.9-deadbeef'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'children.json'), '[]');
      fs.mkdirSync(path.join(runDir, 'keep-me'));
      const s = snapshotChildScripts({ src, runDir, version: '0.1.0' });
      expect(path.basename(path.dirname(s.hookRelay))).toMatch(/^0\.1\.0-[0-9a-f]{8}$/);
      expect(fs.readFileSync(s.hookRelay, 'utf8')).toBe('a');
      expect(fs.readFileSync(s.permissionMcp, 'utf8')).toBe('b');
      expect(fs.existsSync(path.join(runDir, '0.0.9-deadbeef'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'children.json'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'keep-me'))).toBe(true);
      // The package files are replaced (upgrade): the snapshot a running server uses stays as it was.
      fs.writeFileSync(path.join(src, 'hookRelay.js'), 'a2');
      expect(fs.readFileSync(s.hookRelay, 'utf8')).toBe('a');
      expect(snapshotChildScripts({ src, runDir, version: '0.1.0' }).hookRelay).not.toBe(s.hookRelay);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a repo run (.ts) keeps the original paths and writes nothing', () => {
    const runDir = path.join(os.tmpdir(), `deck-snap-none-${process.pid}`);
    const s = snapshotChildScripts({ src: path.dirname(childScript('hookRelay')), runDir, version: '0.1.0' });
    expect(s.hookRelay).toBe(childScript('hookRelay'));
    expect(fs.existsSync(runDir)).toBe(false);
  });
});

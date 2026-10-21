import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Setup and CLI code learn login state from the official status commands only: no credential file, keychain or token flow. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(__dirname));
  walk(path.join(__dirname, '..', 'cli'));
  return out;
}

describe('setup / cli read no credentials', () => {
  it('finds the sources', () => expect(sources().length).toBeGreaterThan(3));
  for (const bad of ['.credentials.json', 'auth.json', 'find-generic-password', 'oauth']) {
    it(`never mentions ${bad}`, () => {
      for (const f of sources()) expect(fs.readFileSync(f, 'utf8').toLowerCase(), f).not.toContain(bad);
    });
  }
});

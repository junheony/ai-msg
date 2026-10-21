import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { childScript } from './childScripts';

describe('childScript', () => {
  it('prefers the bundled .js', () => expect(childScript('hookRelay', '/p', (f) => f === '/p/hookRelay.js' || f === '/p/hookRelay.ts')).toBe('/p/hookRelay.js'));
  it('falls back to the .ts source', () => expect(childScript('permissionMcp', '/s', (f) => f === '/s/permissionMcp.ts')).toBe('/s/permissionMcp.ts'));
  it('throws when neither exists', () => expect(() => childScript('hookRelay', '/n', () => false)).toThrow());
  it('resolves the real source files in this checkout', () => {
    expect(fs.existsSync(childScript('hookRelay'))).toBe(true);
    expect(childScript('permissionMcp').endsWith('permissionMcp.ts')).toBe(true);
  });
});

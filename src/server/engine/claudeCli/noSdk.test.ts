import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Built by concatenation so this file does not match its own scan.
const PKG = ['@anthropic-ai', 'claude-agent-sdk'].join('/');
const ROOT = path.resolve(__dirname, '../../../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') sources(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('the Agent SDK is gone', () => {
  it('no source file imports it', () => {
    const hits = sources(path.join(ROOT, 'src')).filter((f) => new RegExp(`from ['"]${PKG}`).test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it('package.json does not depend on it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) expect(Object.keys(pkg[k] ?? {})).not.toContain(PKG);
  });
});

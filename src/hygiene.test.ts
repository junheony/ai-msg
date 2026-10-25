import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERIC_RULES, RULES_FILE, loadRules, scan, shippedFiles, violations } from './hygiene';

/**
 * `DECK_HYGIENE_ROOT` points the check at another tree and `DECK_HYGIENE_RULES` at a rules file outside it;
 * by default this checkout and its own rules file (when there is one). Never skipped: without git the tree is walked.
 */
const ROOT = path.resolve(process.env.DECK_HYGIENE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const LOCAL_RULES = loadRules(process.env.DECK_HYGIENE_RULES || path.join(ROOT, RULES_FILE));

describe('repository hygiene', () => {
  const files = shippedFiles(ROOT);

  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has nothing key-shaped (or matching the local rules file) in shipped files or their names', () => {
    expect(scan(ROOT, files, [...GENERIC_RULES, ...LOCAL_RULES])).toEqual([]);
  });

  it('testOnlySetNonce is imported only by *.test.ts files', () => {
    const read = (f: string) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
    const offenders = files
      .filter((f) => /\.(ts|tsx|mts)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== path.join('src', 'shared', 'cloud', 'noise.ts'))
      .filter((f) => /\btestOnlySetNonce\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the shared files cloud/ compiles in import only each other by relative path (no zod or other packages in the Worker)', () => {
    let tsconfig: { include?: string[] };
    try { tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloud', 'tsconfig.json'), 'utf8')) as { include?: string[] }; } catch { return; } // public export: no cloud/
    const shared = (tsconfig.include ?? []).filter((p) => p.startsWith('../')).map((p) => path.resolve(ROOT, 'cloud', p));
    expect(shared.length).toBeGreaterThan(0);
    const allowed = new Set(shared);
    const bad: string[] = [];
    for (const file of shared) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        const rel = path.relative(ROOT, file);
        if (!spec.startsWith('./') && !spec.startsWith('../')) bad.push(`${rel}: ${spec}`);
        else if (!allowed.has(path.resolve(path.dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`))) bad.push(`${rel}: ${spec} (not in cloud/tsconfig.json include)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('generic rules catch key shapes and leave short fixtures and marked examples alone', () => {
    const hit = (s: string) => violations(s, GENERIC_RULES).length > 0;
    const run = (n: number) => 'aB3'.repeat(n);
    for (const s of [
      'sk-' + 'ant-api03-' + run(14),
      'sk-' + 'proj-' + run(14),
      'gh' + 'p_' + run(12),
      'github' + '_pat_' + run(12),
      'AK' + 'IA' + 'ABCDEFGH12345678',
      'xox' + 'b-' + '1234567890-abcdef',
      'AI' + 'za' + run(11) + 'ab',
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      '/private/var/folders/' + 'wd/' + 'abcd1234ef_gh5678/T/x',
    ]) expect(hit(s), `${s.slice(0, 6)}…`).toBe(true);
    for (const s of [
      'sk-' + 'ant-api03-' + run(8),
      'sk-' + 'ant-' + 'EXAMPLE' + run(14),
      'sk-notification-task',
      'gh' + 'p_short',
      '-----BEGIN PUBLIC KEY-----',
      '/private/var/folders/wd/x/T/',
    ]) expect(hit(s), s.slice(0, 12)).toBe(false);
  });
});

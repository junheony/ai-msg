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

  it('the Worker (cloud/src and the shared files it compiles in) imports only itself, those shared files and cloudflare:* (no zod, frames or other packages)', () => {
    const cloud = path.join(ROOT, 'cloud');
    if (!fs.existsSync(cloud)) return; // public export: no cloud/
    const raw = fs.readFileSync(path.join(cloud, 'tsconfig.json'), 'utf8');
    let tsconfig: { include?: string[] };
    try { tsconfig = JSON.parse(raw) as { include?: string[] }; } catch {
      // tsconfig may carry comments / trailing commas; strip them (outside strings) and parse again — or fail.
      const stripped = raw.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s: string | undefined) => s ?? '').replace(/,(\s*[}\]])/g, '$1');
      tsconfig = JSON.parse(stripped) as { include?: string[] };
    }
    const shared = (tsconfig.include ?? []).filter((p) => p.startsWith('../')).map((p) => path.resolve(cloud, p));
    expect(shared.length).toBeGreaterThan(0);
    const allowed = new Set(shared);
    const cloudSrc = path.join(cloud, 'src');
    const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : CODE.test(e.name) ? [path.join(d, e.name)] : []);
    const worker = walk(cloudSrc);
    expect(worker.length).toBeGreaterThan(0);
    const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
    /** The file a relative specifier really names (as written, with an extension, `.js`→`.ts`, or `index.*`), else null. */
    const resolve = (from: string, spec: string): string | null => {
      const base = path.resolve(path.dirname(from), spec);
      const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
      const cands = [base, ...exts.map((e) => base + e), base.replace(/\.(m|c)?js$/, (_m, p: string | undefined) => `.${p ?? ''}ts`), ...exts.map((e) => path.join(base, `index${e}`))];
      return cands.find(isFile) ?? null;
    };
    const bad: string[] = [];
    // The shared files import only each other; the Worker's own code also imports itself and `cloudflare:*`.
    for (const file of [...shared, ...worker]) {
      const rel = path.relative(ROOT, file);
      const own = !shared.includes(file);
      // `//` and `/* */` comments are dropped first (string literals kept as they are), so prose such as
      // "uses import(...)" in a comment is not read as code. Inside a string literal it still fails — on purpose.
      const src = fs.readFileSync(file, 'utf8')
        .replace(/('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
      const specs: string[] = [];
      for (const m of src.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)) specs.push(m[1]!);
      // Dynamic import(…) and require(…): only a plain string literal can be checked; anything else fails.
      for (const m of src.matchAll(/\b(import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
        const lit = /^(['"`])([^'"`$]*)\1$/.exec(m[2]!);
        if (!lit || (lit[1] === '`' && m[2]!.includes('${'))) bad.push(`${rel}: ${m[1]}(${m[2]}) (not a plain string literal)`);
        else specs.push(lit[2]!);
      }
      for (const spec of specs) {
        if (own && spec.startsWith('cloudflare:')) continue;
        if (!spec.startsWith('./') && !spec.startsWith('../')) { bad.push(`${rel}: ${spec}`); continue; }
        const target = resolve(file, spec);
        if (!target) { bad.push(`${rel}: ${spec} (no such file)`); continue; }
        if (allowed.has(target)) continue;
        if (own && target.startsWith(cloudSrc + path.sep)) continue;
        bad.push(`${rel}: ${spec} (not cloud/src nor in cloud/tsconfig.json include)`);
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

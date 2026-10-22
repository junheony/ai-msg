import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The i18n leak ratchet's scanner (i18n.leak.test.ts): Korean left in code instead of a dictionary.

export const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** String literals, template pieces and JSX text that carry Hangul (comments and regex literals are not counted). */
export function hangulLiterals(file: string, text: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      if (HANGUL.test(n.text)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.text });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Korean dictionaries: the one place Korean belongs. */
const KO_DICT = /(^|\/)(i18n|messages|prompts)\/(ko\/|ko\.ts$)/;

function walk(dir: string, root: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, root) : [path.relative(root, p).split(path.sep).join('/')];
  });
}

/** Source files under src/ (tracked or new, as git sees them; a plain walk without git), minus tests, test setup and ko dictionaries. */
export function scanTargets(root: string): string[] {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/*.ts', 'src/*.tsx'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    files = walk(path.join(root, 'src'), root);
  }
  return [...new Set(files)]
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('src/test/') && !KO_DICT.test(f) && fs.existsSync(path.join(root, f)))
    .sort();
}

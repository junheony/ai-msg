import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES_FILE, loadRules, violations } from './hygiene';

/**
 * Pins what `.hygiene-private.json` catches and what it leaves alone. This file names the private values in
 * plain text, so it is `export-ignore` (like the rules file) and never part of the public tree.
 */
const RULES = loadRules(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', RULES_FILE));
const hit = (s: string) => violations(s, RULES);
const WORK = '개발';

describe('private hygiene rules', () => {
  it('loads the rules file', () => {
    expect(RULES.length).toBeGreaterThan(5);
  });

  it.each([
    ['home path', '/Users/max/dev'],
    ['home path, linux', 'cwd: /home/max'],
    ['home path, other case', '/users/MAX/x'],
    ['home path, url-encoded', 'file=%2FUsers%2Fmax%2Fproj'],
    ['home path, lower-case url-encoding', '%2fusers%2fmax'],
    ['home path, backslashes', '\\Users\\max\\proj'],
    ['slug', '-Users-max-Documents----x'],
    ['slug without a trailing dash', 'projects/-Users-max'],
    ['slug, other case', '-users-Max-x'],
    ['tilde user', 'cd ~max/bin'],
    ['work folder', `~/Documents/${WORK}/deck`],
    ['work folder, NFD', `Documents/${WORK.normalize('NFD')}`],
    ['work folder, url-encoded NFC', `Documents%2F${encodeURIComponent(WORK)}`],
    ['work folder, url-encoded NFD', `Documents/${encodeURIComponent(WORK.normalize('NFD'))}`],
    ['work folder, lower-case url-encoding', `documents%2f${encodeURIComponent(WORK).toLowerCase()}`],
    ['work folder, path.join arguments', `path.join(home, 'Documents', '${WORK}')`],
    ['work folder under another home', `/Users/alice/${WORK}/x`],
    ['tailnet id', 'host.tail88e649.ts.net'],
    ['tailnet host', 'Max-MacbookPro'],
    ['tailnet address', 'http://100.106.182.94:9320'],
    ['tailnet address, second node', '100.125.168.94'],
    ['project', 'StandX_volume'],
    ['project, other case and separator', 'Agentic_Harness'],
    ['project, spaced', 'agentic harness'],
    ['project', 'quant_analyzer'],
    ['mail id', 'max190927'],
    ['mail, gmail', 'someone@gmail.com'],
    ['mail, another personal domain', 'someone@naver.com'],
    ['mail, another personal domain', 'some.one+x@proton.me'],
    ['account name on its own', 'by junheony'],
    ['account name in another repo slug', 'github.com/junheony/other'],
  ])('catches %s', (_what, text) => {
    expect(hit(text)).not.toEqual([]);
  });

  it.each([
    ['ordinary Korean, slash', `${WORK}/운영 환경`],
    ['ordinary Korean, quoted', `"${WORK}"`],
    ['ordinary Korean, heading', `## ${WORK}`],
    ['ordinary Korean, UI string', `'${WORK} 모드'`],
    ['ordinary Korean after a slash', `설계/${WORK}/운영`],
    ['the neutral folder name', '~/Documents/작업/deck'],
    ['another user', '/Users/alice/Documents'],
    ['a longer user name', '/Users/maxwell/x'],
    ['a longer slug', '-Users-maximum-x'],
    ['code', 'Math.max(a, b); maxLength = 3; { max: 20 }'],
    ['cookie attribute', 'Max-Age=0'],
    ['approximate maximum', '~maximum'],
    ['example tailnet host', 'deck-host.example.ts.net'],
    ['example CGNAT address', '100.64.0.1'],
    ['the public author address', 'hwangmc88@gmail.com'],
    ['the public repo slug', 'https://github.com/junheony/quarterdeck/issues'],
    ['a project mailbox', 'security@example.org'],
    ['an npm scope', '@types/node'],
  ])('leaves %s alone', (_what, text) => {
    expect(hit(text)).toEqual([]);
  });
});

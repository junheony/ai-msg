import { useCallback, useEffect, useState } from 'react';

/** One device-wide switch: fenced code blocks wrap long lines (pre-wrap) instead of scrolling sideways. */
export const CODE_WRAP_KEY = 'deck.codeWrap';
const CHANGE = 'deck:codeWrap';

export function loadCodeWrap(): boolean {
  try { return localStorage.getItem(CODE_WRAP_KEY) === '1'; } catch { return false; }
}

export function saveCodeWrap(on: boolean): void {
  try { localStorage.setItem(CODE_WRAP_KEY, on ? '1' : '0'); } catch { /* private mode: just won't persist */ }
  window.dispatchEvent(new Event(CHANGE));
}

/** Live value shared by every code block and the settings sheet. */
export function useCodeWrap(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(loadCodeWrap);
  useEffect(() => {
    const sync = () => setOn(loadCodeWrap());
    window.addEventListener(CHANGE, sync);
    return () => window.removeEventListener(CHANGE, sync);
  }, []);
  return [on, useCallback((v: boolean) => saveCodeWrap(v), [])];
}

const EXT: Record<string, string> = {
  ts: 'ts', typescript: 'ts', tsx: 'tsx', js: 'js', javascript: 'js', jsx: 'jsx', mjs: 'mjs',
  py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
  json: 'json', jsonc: 'json', md: 'md', markdown: 'md', html: 'html', css: 'css', yaml: 'yaml', yml: 'yaml',
  sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java', swift: 'swift', rb: 'rb', ruby: 'rb', toml: 'toml', xml: 'xml', svg: 'svg', diff: 'diff',
};

/** `code-N.<ext>` for a block's language; an unknown language saves as .txt. */
export function codeFileName(lang: string, n: number): string {
  return `code-${n}.${EXT[lang.toLowerCase()] ?? 'txt'}`;
}

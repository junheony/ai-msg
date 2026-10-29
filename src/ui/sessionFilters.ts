/** Codex `exec` and Grok headless runs: folded under 자동 실행 unless the owner pinned them (a deck title or continue-link already dropped the flag). */
export function isAutomatedSession(s: { codexExec?: boolean; autoRun?: boolean }): boolean {
  return s.codexExec === true || s.autoRun === true;
}

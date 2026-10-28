/**
 * The notice shown when a session's transcript was just written outside deck (another app may still have it open):
 * which conversation, by what, how long ago, what goes wrong if both keep writing, and what to do.
 */
const WHAT = { claude: '대화', codex: 'GPT 대화', grok: 'Grok 대화', gemini: 'Gemini 대화' } as const;
const WHERE = { claude: 'Claude Desktop 또는 Claude CLI', codex: 'Codex 앱 또는 Codex CLI', grok: 'grok CLI', gemini: 'agy CLI 또는 Antigravity' } as const;

export function elsewhereNotice(o: { engine: 'claude' | 'codex' | 'grok' | 'gemini'; title: string | null; ageMs: number }): string {
  const name = o.title?.trim() ? `「${o.title.trim()}」 ` : '이 ';
  const what = WHAT[o.engine];
  const where = WHERE[o.engine];
  const mins = Math.floor(Math.max(0, o.ageMs) / 60_000);
  const when = mins < 1 ? '방금' : `${mins}분 전에`;
  return `${name}${what}의 기록 파일이 ${when} MSG 밖(${where})에서 바뀌었어요. 그쪽에서 아직 열려 있다면 한 곳에서만 이어 쓰세요 — 두 곳에서 동시에 쓰면 서로의 새 메시지를 못 본 채 대화가 두 갈래로 나뉩니다.`;
}

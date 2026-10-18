/**
 * "새 세션으로 이어가기": one turn in the current session (warm cache) writes a handoff note, then a new session
 * in the same folder opens with the note prefilled in the composer. The server runs that turn with every tool call
 * denied (the tool list itself is left unchanged so the prompt cache still hits).
 */
export const HANDOFF_PROMPT = [
  '이 대화를 새 세션으로 넘기려고 합니다. 새 세션의 Claude 가 이 대화를 전혀 보지 못한 채 바로 이어서 작업할 수 있도록 간결한 인계 메모를 한국어 마크다운으로 써 주세요.',
  '',
  '다음 항목을 이 순서로, 제목(##)과 짧은 목록으로:',
  '1. 목표 — 이 작업이 이루려는 것',
  '2. 내린 결정 — 무엇을 왜 그렇게 정했는지',
  '3. 현재 상태 — 건드린 파일·브랜치·커밋, 실행 중이거나 남아 있는 것',
  '4. 남은 문제 — 아직 풀리지 않은 것, 알려진 위험',
  '5. 다음 단계 — 바로 실행할 수 있게 구체적으로',
  '6. 지켜야 할 제약·사용자 선호',
  '',
  '도구는 쓰지 말고(파일을 읽거나 명령을 실행하지 말고) 지금까지의 대화만으로 쓰세요. 메모 본문만 답하고 앞뒤 인사말은 빼 주세요.',
].join('\n');

export const HANDOFF_COMMAND = 'handoff';

/** The new session's title: "<old title> (이어서)". */
export function handoffTitle(oldTitle: string): string {
  return `${oldTitle.trim() || '세션'} (이어서)`;
}

/** The new session's first user message (prefilled, never sent without the user pressing Enter). */
export function handoffFirstMessage(oldTitle: string, oldSessionId: string, note: string): string {
  return `이전 세션(${oldTitle}, ${oldSessionId})에서 이어서 작업합니다. 인계 메모:\n\n${note.trim()}\n\n이어서 진행할 준비가 되면 짧게 확인만 해 주세요.`;
}

/**
 * codex-cli takes a per-thread writer lock; while the ChatGPT desktop app has the thread loaded, `codex exec resume`
 * fails with "already has an active writer" and deck shows this (CodexEngine). The server marks such a turn_result
 * `errorCode: 'thread_locked'`; an older server only sends this text.
 * Keep the wording: a UI recognises an older server's locked turn by this exact prefix (isThreadLocked).
 */
export const THREAD_LOCKED_MESSAGE =
  '이 GPT 스레드를 다른 프로그램이 쓰고 있어 deck 에서 이어갈 수 없습니다 — 보통 ChatGPT 데스크톱 앱(Codex)이 이 스레드를 열어 두고 있을 때입니다(/goal 자동 진행 포함). ' +
  '데스크톱 앱에서 이어가거나, 데스크톱 앱을 종료(⌘Q)한 뒤 재시도하세요.';

/** A failed GPT turn the desktop app's thread lock refused: its error code, or (an older server) its error text. */
export function isThreadLocked(errorCode: string | null | undefined, errorText: string | null | undefined): boolean {
  return errorCode === 'thread_locked' || (errorText ?? '').startsWith(THREAD_LOCKED_MESSAGE);
}

/** "deck 에서 새 GPT 세션으로 이어가기": each excerpted message is cut at this many characters… */
export const CODEX_HANDOFF_MESSAGE_MAX = 2000;
/** …and the excerpt as a whole keeps at most this many (the oldest messages go first). */
export const CODEX_HANDOFF_EXCERPT_MAX = 12000;

/**
 * The earlier conversation for a new GPT session: user and assistant text only (no tool calls, thinking or notes), oldest
 * first, as `**사용자:**` / `**GPT:**` paragraphs. Pass the items before the failed turn's request.
 */
export function codexHandoffExcerpt(items: readonly { kind: string; text?: string }[], assistantLabel = 'GPT'): string {
  const paras = items.flatMap((it) => {
    if ((it.kind !== 'user' && it.kind !== 'assistant') || !it.text?.trim()) return [];
    const t = it.text.trim();
    // Never cut a surrogate pair in half (codex would get U+FFFD).
    const n = CODEX_HANDOFF_MESSAGE_MAX - (/[\uD800-\uDBFF]/.test(t[CODEX_HANDOFF_MESSAGE_MAX - 1] ?? '') ? 1 : 0);
    const cut = t.length > CODEX_HANDOFF_MESSAGE_MAX ? `${t.slice(0, n)}…(생략)` : t;
    return [`**${it.kind === 'user' ? '사용자' : assistantLabel}:** ${cut}`];
  });
  let start = paras.length;
  let total = 0;
  while (start > 0) {
    const add = paras[start - 1]!.length + (start < paras.length ? 2 : 0);
    if (total + add > CODEX_HANDOFF_EXCERPT_MAX) break;
    total += add;
    start--;
  }
  const kept = paras.slice(start).join('\n\n');
  return start > 0 ? `(앞부분 생략)\n\n${kept}` : kept;
}

/** The new GPT session's first message (prefilled, sent only when the user presses Enter). */
export function codexHandoffMessage(oldTitle: string, oldSessionId: string, excerpt: string, request: string): string {
  return [
    `이전 GPT 세션(${oldTitle}, ${oldSessionId})이 다른 앱에 열려 있어 deck 에서 새 세션으로 이어갑니다. 아래는 이전 대화 발췌입니다(도구 호출 제외).`,
    excerpt.trim() || '(발췌할 이전 대화가 없습니다)',
    '이어서 할 요청:',
    request,
  ].join('\n\n');
}

/** The first message of a deck Grok session continuing a Grok Bot app conversation (prefilled, sent only when the user does). */
export function grokBotHandoffMessage(oldTitle: string, excerpt: string): string {
  return [
    `Grok Bot 앱 대화(${oldTitle})를 deck Grok 새 세션으로 이어갑니다. 아래는 이전 대화 발췌입니다(도구 호출 제외).`,
    excerpt.trim() || '(발췌할 이전 대화가 없습니다)',
    '이어서 할 요청:',
    '',
  ].join('\n\n');
}

/** Shown under the composer of an imported agy (Gemini) conversation: its past messages are not replayed in deck. */
export const GEMINI_IMPORT_NOTE = '이전 메시지는 deck 에 보이지 않지만 agy 가 기억하고 이어갑니다';

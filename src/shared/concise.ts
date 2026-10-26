/**
 * 간결 모드 helpers (shared): ack labels, mid-turn event classification, milestone copy.
 * The preference itself lives in the client (`prefs.conciseMode`, default on). Full mode is unchanged
 * when the pref is off — these helpers only decide what the concise UI surfaces.
 */

import { modelLabelOf, type AnyModel, type EngineKind } from './models';

/** Short Korean engine label for the ack line. */
export const CONCISE_ENGINE_LABEL: Record<EngineKind, string> = {
  claude: 'Claude',
  codex: 'GPT',
  gemini: 'Gemini',
  grok: 'Grok',
};

/**
 * Instant ack after routing is known (turn_started): "GPT Sol · 작업 중", or with a first step "Opus · 원인부터 찾을게요".
 * Prefers a short model name; falls back to the engine label. The account letter is an internal name: the status row
 * puts it in the tooltip, never in this line.
 */
export function conciseAck(input: {
  model?: string | null;
  engine?: EngineKind | null;
  /** First step guessed from the prompt (conciseFirstStep). */
  step?: string | null;
}): string {
  const model = input.model ? modelLabelOf(input.model) : null;
  const who = model ?? (input.engine ? CONCISE_ENGINE_LABEL[input.engine] : null) ?? '모델';
  const step = input.step?.trim();
  return `${who} · ${step || '작업 중'}`;
}

/**
 * Instant, deterministic first step for the ack line (no model call): what the turn will most likely do first,
 * from cue words in the prompt. null = no clear cue (the ack then just names the model).
 * Order matters: a failing test / error beats a plain build cue, a question beats nothing.
 */
const FIRST_STEPS: [RegExp, string][] = [
  [/왜\s*(안\s*)?(실패|깨|안\s*돼|안\s*되|죽)|원인|에러|오류|버그|안\s*돼|안\s*되|\bbug\b|\berror\b|\bfail|\bcrash|\bbroken\b/i, '원인부터 찾을게요'],
  [/테스트|돌려|실행해|빌드해|\btests?\b|\brun\b|\bbuild it\b/i, '먼저 실행해 볼게요'],
  [/고쳐|수정해|구현|만들어|추가해|리팩터|리팩토링|작성해|\bimplement|\bfix\b|\badd\b|\brefactor/i, '관련 코드부터 볼게요'],
  [/설계|아키텍처|구조|계획|방안|\bdesign\b|\barchitect|\bplan\b/i, '현재 구조부터 살펴볼게요'],
  [/요약|정리해|번역|\bsummari[sz]e\b|\btranslate\b/i, '내용부터 읽어 볼게요'],
  [/찾아|어디|검색|\bfind\b|\bwhere\b|\bsearch\b/i, '먼저 찾아볼게요'],
  [/뭐야|무엇|설명|알려|어떻게|\?\s*$|\bwhat\b|\bhow\b|\bwhy\b|\bexplain\b/i, '바로 답할게요'],
];

export function conciseFirstStep(prompt: string | null | undefined): string | null {
  const t = (prompt ?? '').trim();
  if (!t) return null;
  for (const [re, step] of FIRST_STEPS) if (re.test(t)) return step;
  return null;
}

/**
 * Appended to the system prompt of turns sent in 간결 모드 (`send.concise`; Claude: `--append-system-prompt`).
 * Never shown in the pane. Kept short: it rides every turn's process.
 */
export const CONCISE_STYLE_PROMPT = [
  '[deck 간결 모드] 사용자는 대개 폰으로 봅니다. 두괄식으로, 하지만 내용은 빠짐없이 답하세요:',
  '- 도구를 쓰는 긴 작업이면 맨 처음에 무엇부터 할지 한 문장만 쓰고 바로 진행하세요(예: "먼저 실패하는 테스트부터 볼게요.").',
  // Three bullets in one literal (joined by \n): the i18n leak ratchet counts literals per file.
  '- 사용자에게 보이는 답은 턴의 마지막 메시지(도구를 다 쓴 뒤 마지막으로 쓰는 글)입니다. 도구로 알아낸 결과·결론은 반드시 그 본문에 쓰세요. "기록해 뒀어요"·"파일에 정리했어요"는 답이 아닙니다 — HANDOFF·메모·파일에 적는 일은 답을 쓴 다음의 덧붙임입니다. 마지막 메시지는 그것만 읽어도 답이 되게 결론·근거를 담고, "위 그대로"·"앞서 말한 대로"·"위 내용 참고"처럼 앞을 가리키지 마세요.\n- 첫 문장에서 바로 답하세요(결론·결과). 이어서 판단에 필요한 근거·숫자·원인·다음 할 일을 질문의 무게만큼 쓰세요 — 줄이느라 정보를 빼지 마세요. 쉬운 한국어로. 인사말·과정 되풀이·같은 말 반복·"도와드릴게요" 같은 군더더기는 쓰지 마세요.\n- 사용자가 여러 가지를 묻거나 시켰으면 하나도 건너뛰지 말고 전부 답하거나 처리하세요. 못 한 것·미룬 것은 그렇다고 쓰세요.',
  '- 짧은 문단이 기본. 나열할 게 셋 이상이면 목록으로, 항목 앞에 굵은 짧은 이름표(**이름:** 설명)를 붙여도 좋아요. 표·제목은 꼭 필요할 때만. 파일·명령은 인라인 코드로.',
  '- 사용자가 골라야 할 결정이 있으면 문장으로 묻지 말고 AskUserQuestion 도구로 2–4개의 짧은 선택지를 주세요.',
  '- 되돌리기 어려운 행동(메시지·메일 전송, 삭제, 결제, 배포·push, 실거래 설정 변경)은 실행하지 말고 초안·변경 내용을 보여 준 뒤 확인을 받으세요.',
].join('\n');

/**
 * The style note for an engine: Claude asks decisions with its AskUserQuestion tool; GPT, Gemini and Grok have no such
 * tool, so their note leaves that line out (they get shared/choices DECK_CHOICES_PROMPT instead). A 백그라운드 작업 turn
 * (`task`) leaves it out too: nobody watches that session, so a question card would only hold its slot.
 */
export function conciseStylePrompt(engine: EngineKind, opts: { task?: boolean } = {}): string {
  if (engine === 'claude' && !opts.task) return CONCISE_STYLE_PROMPT;
  return CONCISE_STYLE_PROMPT.split('\n').filter((l) => !l.includes('AskUserQuestion')).join('\n');
}

/** Tags a `send` / `start_task` with `concise: true` while 간결 모드 is on (other messages, handoff-note turns: unchanged). */
export function withConcise<M extends { type: string }>(msg: M, on: boolean): M {
  if (!on || (msg.type !== 'send' && msg.type !== 'start_task')) return msg;
  if ((msg as { handoff?: boolean }).handoff) return msg;
  return { ...msg, concise: true };
}

/** How the concise UI treats each mid-turn server event (full mode ignores this). */
export type ConciseEventRole =
  | 'surface'      // show as-is (started, result, permission, question)
  | 'milestone'    // collapse into a progress milestone
  | 'stream'       // show live as it arrives (streamed answer text, the text between tool calls too)
  | 'suppress';     // hide body mid-turn (thinking chunks, tool result bodies)

const ROLES: Record<string, ConciseEventRole> = {
  turn_started: 'surface',
  turn_result: 'surface',
  turn_retry: 'surface',
  permission_request: 'surface',
  question_request: 'surface',
  route_fit: 'surface',
  error: 'surface',
  turn_notice: 'surface',
  turn_system: 'surface',
  turn_queued: 'surface',
  turn_progress: 'milestone',
  tool_call: 'milestone',
  sub_tool_call: 'milestone',
  task_update: 'milestone',
  thinking: 'suppress',
  tool_result: 'suppress',
  sub_tool_result: 'suppress',
  delta: 'stream',
};

export function conciseEventRole(type: string): ConciseEventRole {
  return ROLES[type] ?? 'suppress';
}

/** Whether this event type is forwarded into the concise chat pane mid-turn. */
export function conciseForwardsEvent(type: string): boolean {
  const role = conciseEventRole(type);
  return role === 'surface' || role === 'milestone' || role === 'stream';
}

/**
 * Milestone copy for a long turn: started → periodic still-working → done.
 * `step` is 1-based tool/progress steps; `elapsedMs` drives the "still working" cadence.
 */
export function conciseMilestone(input: {
  phase: 'started' | 'working' | 'done';
  step?: number;
  elapsedMs?: number;
  ok?: boolean;
}): string {
  if (input.phase === 'started') return '시작함';
  if (input.phase === 'done') return input.ok === false ? '끝남 · 실패' : '끝남';
  const step = input.step && input.step > 0 ? input.step : null;
  const mins = input.elapsedMs !== undefined ? Math.floor(input.elapsedMs / 60_000) : 0;
  if (step !== null && mins >= 1) return `계속 작업 중 · 단계 ${step} · ${mins}분`;
  if (step !== null) return `계속 작업 중 · 단계 ${step}`;
  if (mins >= 1) return `계속 작업 중 · ${mins}분`;
  return '계속 작업 중';
}

/** Emit a working milestone at most this often (server filter / UI status). */
export const CONCISE_MILESTONE_MS = 20_000;

/**
 * Pure filter: given prior milestone state and a new event, decide whether to emit a milestone notice.
 * Used by the server turn pipeline and covered by unit tests; the UI also mirrors the same cadence.
 */
export function shouldEmitMilestone(state: {
  lastAtMs: number;
  steps: number;
  startedAtMs: number;
}, nowMs: number, eventType: string): { emit: boolean; next: { lastAtMs: number; steps: number; startedAtMs: number }; message?: string } {
  const role = conciseEventRole(eventType);
  let steps = state.steps;
  if (eventType === 'tool_call' || eventType === 'sub_tool_call') steps += 1;
  if (eventType === 'turn_started') {
    return { emit: true, next: { lastAtMs: nowMs, steps: 0, startedAtMs: nowMs }, message: conciseMilestone({ phase: 'started' }) };
  }
  if (eventType === 'turn_result') {
    return { emit: true, next: { ...state, lastAtMs: nowMs, steps }, message: conciseMilestone({ phase: 'done', step: steps || undefined, elapsedMs: nowMs - state.startedAtMs }) };
  }
  if (role !== 'milestone') return { emit: false, next: { ...state, steps } };
  const due = nowMs - state.lastAtMs >= CONCISE_MILESTONE_MS;
  const stepBump = steps > state.steps && (steps === 1 || steps % 3 === 0);
  if (!due && !stepBump) return { emit: false, next: { ...state, steps } };
  return {
    emit: true,
    next: { lastAtMs: nowMs, steps, startedAtMs: state.startedAtMs },
    message: conciseMilestone({ phase: 'working', step: steps || undefined, elapsedMs: nowMs - state.startedAtMs }),
  };
}

/** Short model chip for routing tables / docs (AnyModel id → Korean-ish short name). */
export function conciseModelChip(model: AnyModel | string): string {
  return modelLabelOf(model);
}

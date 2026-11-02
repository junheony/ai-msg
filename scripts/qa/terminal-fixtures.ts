/** Synthetic display evidence only. No model invocation, account data, or live filesystem reads. */
import type { SessionEntry, TranscriptMessage } from '../../src/shared/session-types';

export const hermesFixtureId = 'qa-hermes-terminal-brief7';
const ts = '2026-11-01T16:36:00.000Z';
export const hermesFixtureMessages: TranscriptMessage[] = [
  { kind: 'user', text: '터미널의 흐름을 정리해 줘. 작업 과정은 접어 두고, 결과와 다음 행동이 먼저 보이게.', ts, n: 0 },
  { kind: 'assistant', model: 'gpt-6-astra', text: '', thinking: '대화의 흐름과 도구 결과를 확인한 뒤, 필요한 정보만 남긴다. 먼저 헤더와 작업 과정의 우선순위를 살펴본다.', toolCalls: [{ id: 'qa-read', name: 'read_file', input: { path: 'src/ui/components/Terminal.tsx' } }], ts },
  { kind: 'tool_result', toolUseId: 'qa-read', content: 'Synthetic fixture: header, activity group, and composer structure inspected.', isError: false, ts },
  { kind: 'assistant', model: 'gpt-6-astra', text: '', thinking: '작업 과정의 상태는 실패한 도구도 반영해야 한다. 결과 문장과 코드의 대비를 정리하고 작은 화면도 확인한다.', toolCalls: [{ id: 'qa-check', name: 'terminal', input: { command: 'npm run check:preview' } }], ts },
  { kind: 'tool_result', toolUseId: 'qa-check', content: 'Synthetic fixture: optional preview target is unavailable. No command was actually run.', isError: true, ts },
  { kind: 'assistant', model: 'gpt-6-astra', text: 'SUCCESS\n\n터미널의 정보 순서를 정리했습니다.\n\n### 결과가 먼저 보이도록\n\n세션 이름은 한 줄로, 모델과 승인 방식은 작고 조용하게 배치했습니다. 작업 과정은 필요할 때 펼쳐 볼 수 있습니다.\n\n```typescript\nconst terminal = {\n  engine: \'hermes\',\n  model: \'gpt-6-astra\',\n  approval: \'ask\',\n};\n\nfunction summarize(errors: number) {\n  return errors > 0 ? \'PARTIAL\' : \'SUCCESS\';\n}\n```\n\n미리보기 도구 한 건을 확인하지 못했습니다. 작업 과정에 오류를 남겨 후속 확인이 필요한 부분을 구분했습니다.\n\n**다음 단계** · 변경 내용을 검토하고, 준비되면 다음 작업을 이어가세요.', toolCalls: [], ts },
];

export function terminalFixtureSessions(): SessionEntry[] {
  const models = [
    { sessionId: hermesFixtureId, engine: 'hermes', account: 'hermes', title: '터미널의 흐름을 다듬다', preview: 'Hermes · 결과부터 읽히는 작업 공간' },
    { sessionId: 'qa-claude-terminal', engine: 'claude', account: 'a', title: '랜딩 페이지의 첫인상', preview: 'Claude · 타이포그래피와 간격 정리' },
    { sessionId: 'qa-codex-terminal', engine: 'codex', account: 'gpt', title: '작은 화면에서도 자연스럽게', preview: 'Codex · 반응형 레이아웃 확인' },
    { sessionId: 'qa-gemini-terminal', engine: 'gemini', account: 'g1', title: '리서치를 한눈에', preview: 'Gemini · 자료와 링크 모으기' },
    { sessionId: 'qa-grok-terminal', engine: 'grok', account: 'x1', title: '놓친 관점을 찾아서', preview: 'Grok · 독립적인 교차 검토' },
  ] as const;
  return models.map((model, i) => ({ ...model, cwd: '/workspace/agentic-harness', projectDir: '', file: '', lastModified: Date.parse(ts) - i * 60000, sizeBytes: 1 }));
}

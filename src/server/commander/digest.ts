/**
 * 총사령탑 세그먼트 누적기 — `docs/superpowers/specs/2026-10-18-commander-design.md` §3 "입력 — SegmentDigest".
 * 세션이 busy 가 된 순간부터 idle 로 돌아갈 때까지의 이벤트(cap·bg failover·retry 하위 턴 포함)를 받아 §3 표의
 * 상한으로 자른 판정 입력을 만든다. 입출력은 없고, 아직 TurnRunner·ws 에 연결되지 않았다(§10 4단계).
 */
import path from 'node:path';
import { classifyFailure, type FailureKind } from '../engine/limitDetect';
import { segmentSignature } from './signature';
import type { SegmentDigest, TestRun } from './types';

/**
 * TurnRunner 가 흘릴 이벤트 — 같은 이름의 `ServerMessage` 의 부분 모양이라 그 메시지를 그대로 넘겨도 된다.
 * `sub_tool_result.content` 는 지금 서버가 내지 않는다(없으면 출력 없음 = 테스트 증거 아님).
 * `turn_result.errorKind`·`failure` 는 `ServerMessage` 에 없는 서버 내부 값 — 있으면 실패 분류에 쓴다.
 */
export type SegmentEvent =
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'sub_tool_call'; parentToolUseId: string; toolUseId: string; name: string; input: unknown }
  | { type: 'sub_tool_result'; parentToolUseId: string; toolUseId: string; isError: boolean; content?: string }
  | { type: 'turn_result'; turnId?: string; ok: boolean; text: string; errorText: string | null; errorKind?: string | null; failure?: FailureKind | null }
  /** 백그라운드 세그먼트가 한도로 끊겨 다른 계정으로 넘어감(같은 turnId 로 다시 돈다) — 그 턴은 bg 이어가기가 아니라 failover. */
  | { type: 'turn_retry'; turnId: string };

/** 백그라운드 이어가기 턴(`<turnId>:bg<n>`) — 내부 재시도가 아니다. */
const BG_TURN_RE = /:bg\d+$/;

export const DIGEST_LIMITS = {
  summary: 4_000,
  summaryHead: 1_500,
  files: 40,
  tests: 1_200,
  testCommand: 160,
  testOutput: 600,
  errorText: 200,
} as const;

const OMIT = '\n…(중간 생략)…\n';
/** 명령 맨 앞(접두 소거 뒤)에서만 맞춰야 하는 러너 키워드 — `isTestRunnerCommand` 가 쓴다. */
export const TEST_RUNNER_RE = /^(?:vitest|jest|pytest|go test|cargo test|npm test|pnpm test)\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FORBIDDEN_OPERATORS = /[|;`<>]/;

/**
 * §3 HIGH 수정(digest.ts:34): 테스트 실행 판별을 명령 맨 앞으로 좁힌다.
 * 허용 접두: `cd <path> &&`(한 번), 환경변수 할당(`FOO=bar ...`), `npx`/`pnpm exec`/`yarn`.
 * 파이프·`||`·`;`·단독 `&`·리다이렉트(`>`,`<`)·`$(`·백틱이 섞이면 증거로 보지 않는다
 * (`&&` 연결은 `cd` 접두 외엔 보수적으로 제외).
 */
export function isTestRunnerCommand(command: string): boolean {
  let cmd = command.trim();
  if (FORBIDDEN_OPERATORS.test(cmd) || cmd.includes('$(')) return false;
  if (cmd.includes('&&')) {
    const parts = cmd.split('&&').map((s) => s.trim());
    if (parts.length !== 2 || !/^cd\s+\S+$/.test(parts[0]!)) return false;
    cmd = parts[1]!;
    if (FORBIDDEN_OPERATORS.test(cmd) || cmd.includes('$(') || cmd.includes('&&')) return false;
  }
  if (cmd.includes('&')) return false; // 단독 백그라운드 `&`(`&&` 는 위에서 이미 소거됨).
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cmd)) cmd = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  cmd = cmd.replace(/^(?:npx|pnpm exec|yarn)\s+/, '').trim();
  return TEST_RUNNER_RE.test(cmd);
}

/** 머리 1,500자 + 생략 표시 + 꼬리, 합 ≤ 4,000자. */
export function clipSummary(text: string): string {
  if (text.length <= DIGEST_LIMITS.summary) return text;
  const tail = DIGEST_LIMITS.summary - DIGEST_LIMITS.summaryHead - OMIT.length;
  return text.slice(0, DIGEST_LIMITS.summaryHead) + OMIT + text.slice(-tail);
}

/**
 * Bash 출력의 exit code — 첫 줄이 `Exit code <n>` 형태일 때만 그 값을 믿고, 그 외엔 `is_error` 로 0/1.
 * §3 HIGH 수정(digest.ts:45-48): `isError` 가 true 면 절대 0 을 반환하지 않는다.
 */
export function exitCodeOf(output: string, isError: boolean): number {
  const firstLine = output.split('\n')[0] ?? '';
  const m = /^Exit code (\d+)/i.exec(firstLine);
  if (m) {
    const code = Number(m[1]);
    return isError && code === 0 ? 1 : code;
  }
  return isError ? 1 : 0;
}

type Run = { id: string; command: string; sub: boolean; seq: number; output: string | null; isError: boolean };

export class SegmentCollector {
  private seq = 0;
  private readonly files = new Set<string>();
  private lastChangeSeq = -1;
  private readonly runs: Run[] = [];
  private readonly runById = new Map<string, Run>();
  private turns = 0;
  /** 내부 재시도로 세지 않는 bg 이어가기 turn_result 수. */
  private bgTurns = 0;
  private readonly retried = new Set<string>();
  private last: Extract<SegmentEvent, { type: 'turn_result' }> | null = null;

  constructor(private readonly cwd: string) {}

  add(ev: SegmentEvent): void {
    const seq = ++this.seq;
    switch (ev.type) {
      case 'tool_call':
      case 'sub_tool_call':
        this.call(ev.toolUseId, ev.name, ev.input, ev.type === 'sub_tool_call', seq);
        break;
      case 'tool_result':
        this.result(ev.toolUseId, ev.content, ev.isError);
        break;
      case 'sub_tool_result':
        this.result(ev.toolUseId, ev.content ?? '', ev.isError);
        break;
      case 'turn_result':
        this.turns++;
        if (ev.turnId && BG_TURN_RE.test(ev.turnId) && !this.retried.has(ev.turnId)) this.bgTurns++;
        this.last = ev;
        break;
      case 'turn_retry':
        this.retried.add(ev.turnId);
        break;
    }
  }

  private call(id: string, name: string, input: unknown, sub: boolean, seq: number): void {
    const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (EDIT_TOOLS.has(name)) {
      // NotebookEdit 의 실제 입력 이름은 notebook_path 다.
      const p = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : null;
      if (p) {
        const rel = path.isAbsolute(p) ? path.relative(this.cwd, p) : p;
        this.files.add(rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? p : rel);
      }
      this.lastChangeSeq = seq;
      return;
    }
    if (name === 'Bash' && typeof inp.command === 'string') {
      if (isTestRunnerCommand(inp.command)) {
        if (!this.runById.has(id)) {
          const run: Run = { id, command: inp.command, sub, seq, output: null, isError: false };
          this.runs.push(run);
          this.runById.set(id, run);
        }
      } else {
        // §3 MEDIUM 수정(digest.ts:86-94): 러너가 아닌 Bash 실행은 파일을 바꿨을 수 있으니 보수적으로 변경으로 본다.
        this.lastChangeSeq = seq;
      }
    }
  }

  private result(id: string, content: string, isError: boolean): void {
    const run = this.runById.get(id);
    if (!run || run.output !== null) return;
    run.output = content;
    run.isError = isError;
  }

  digest(digestId: string): SegmentDigest {
    const last = this.last;
    // §3 LOW 수정(digest.ts:112): turn_result 가 하나도 없는 세그먼트는 성공으로 보지 않는다.
    const ok = last ? last.ok : false;
    const errorText = last && !last.ok && last.errorText ? last.errorText : null;
    const kind = last && !last.ok
      ? last.failure !== undefined ? last.failure : classifyFailure({ ok: false, errorText: last.errorText, errorKind: last.errorKind ?? null, rateLimitStatus: null })
      : null;
    const allRuns = this.runs.map((r) => this.toTestRun(r));
    return {
      digestId,
      turns: this.turns,
      retries: Math.max(0, this.turns - 1 - this.bgTurns),
      summary: clipSummary(last?.text ?? ''),
      changedFiles: [...this.files].slice(0, DIGEST_LIMITS.files),
      changedFileCount: this.files.size,
      testRuns: fitTests(allRuns),
      failure: { ok, errorText: errorText === null ? null : errorText.slice(0, DIGEST_LIMITS.errorText), kind },
      signature: segmentSignature({
        ok,
        errorText,
        changedFileCount: this.files.size,
        tests: this.runs.map((r) => ({ command: r.command, exitCode: r.output === null ? null : exitCodeOf(r.output, r.isError), output: r.output ?? '' })),
      }),
    };
  }

  private toTestRun(r: Run): TestRun {
    const out = r.output ?? '';
    const firstLine = r.command.split('\n')[0] ?? '';
    return {
      testRunId: r.id,
      command: firstLine.slice(0, DIGEST_LIMITS.testCommand),
      outputTail: out.trim() === '' ? '' : out.slice(-DIGEST_LIMITS.testOutput),
      hasOutput: out.trim() !== '',
      exitCode: r.output === null ? null : exitCodeOf(out, r.isError),
      filesChangedAfter: this.lastChangeSeq > r.seq,
      sub: r.sub,
    };
  }
}

/** 최근 실행부터 명령+출력 합이 1,200자 안에 들도록 담고 시간순으로 돌려준다. 마지막 실행은 잘라서라도 넣는다. */
function fitTests(runs: TestRun[]): TestRun[] {
  const kept: TestRun[] = [];
  let left: number = DIGEST_LIMITS.tests;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    const size = r.command.length + r.outputTail.length;
    if (size <= left) { kept.push(r); left -= size; continue; }
    if (kept.length === 0) {
      const command = r.command.slice(0, left);
      const outputTail = left - command.length > 0 ? r.outputTail.slice(-(left - command.length)) : '';
      kept.push({ ...r, command, outputTail, hasOutput: outputTail.trim() !== '' && r.hasOutput });
    }
    break;
  }
  return kept.reverse();
}

/**
 * §3 완료 근거 검사: `testRunId` 가 digest 에 실제로 있고, 출력이 있으며(exit code 만으로는 인정 안 함),
 * exit code 가 0 이고, 그 실행 이후 파일 변경이 없을 때만 true.
 */
export function doneEvidenceOk(d: SegmentDigest, testRunId: string): boolean {
  const r = d.testRuns.find((t) => t.testRunId === testRunId);
  return !!r && r.hasOutput && r.exitCode === 0 && !r.filesChangedAfter;
}

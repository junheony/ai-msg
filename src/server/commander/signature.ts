/**
 * 총사령탑 진척 없음 감지 — `docs/superpowers/specs/2026-10-18-commander-design.md` §5 "진척 없음".
 * 모델이 고른 문자열이 아니라 서버가 정규화한 서명만 쓴다. 순수 함수.
 *
 * 세그먼트 서명 한 줄 = `<오류 해시>.<바뀐 파일 수>.<테스트 결과 해시>` (`CommanderState.signatures` 는 string[≤3]).
 * 오류 해시는 실패가 없으면 `-`.
 */
import { createHash } from 'node:crypto';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** 경로·숫자·해시를 지워 같은 오류가 다른 줄 번호·임시 경로로 나와도 같은 문자열이 되게 한다. */
export function normalizeErrorLine(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first
    .replace(/(?:[A-Za-z]:)?(?:[\w.@~-]*[\\/])+[\w.@-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

const FAILED_TEST_PATTERNS: RegExp[] = [
  /^\s*(?:FAIL|×|✕|✗)\s+(.+?)\s*(?:\[\s*\S+\s*\])?\s*$/gm, // vitest / jest
  /^FAILED\s+(\S+)/gm, // pytest
  /^\s*--- FAIL:\s+(\S+)/gm, // go test
  /^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/gm, // cargo test
];

/** 테스트 출력에서 실패 테스트 이름 집합(정렬, 숫자·시간 표기 제거). */
export function failedTestNames(output: string): string[] {
  const out = new Set<string>();
  for (const re of FAILED_TEST_PATTERNS) {
    for (const m of output.matchAll(re)) {
      const name = (m[1] ?? '').replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/, '').trim();
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

export type SignatureInput = {
  ok: boolean;
  errorText: string | null;
  changedFileCount: number;
  tests: { command: string; exitCode: number | null; output: string }[];
};

/** 세그먼트 하나의 서명. */
export function segmentSignature(s: SignatureInput): string {
  const failed = new Set<string>();
  for (const t of s.tests) for (const n of failedTestNames(t.output)) failed.add(n);
  const failedList = [...failed].sort();
  const errLine = s.ok || !s.errorText ? '' : normalizeErrorLine(s.errorText);
  const err = failedList.length === 0 && errLine === '' ? '-' : hash(`${failedList.join('\n')}\u0000${errLine}`);
  const testKey = hash(s.tests.map((t) => `${normalizeErrorLine(t.command)}\u0000${t.exitCode ?? '?'}`).join('\n') + `\u0000${failedList.join('\n')}`);
  return `${err}.${s.changedFileCount}.${testKey}`;
}

function parse(sig: string): { err: string; changed: number; tests: string } | null {
  const m = /^([^.]+)\.(\d+)\.([^.]+)$/.exec(sig);
  return m ? { err: m[1]!, changed: Number(m[2]), tests: m[3]! } : null;
}

/**
 * 최근 3세그먼트(오래된 것부터)로 진척 없음을 판정한다: 같은 오류 서명 2회(A/B 교대 A,B,A 도 여기 포함),
 * 또는 3세그먼트 연속 바뀐 파일 0·테스트 결과 동일.
 * §5 MEDIUM 수정(signature.ts:69-73): 마지막 세그먼트가 이전 오류를 해결했으면(오류 없음이고 그 전에 오류가 있었으면)
 * 진척 없음으로 보지 않는다 — 한 번도 오류가 없던 정체(변경 0·결과 동일)는 그대로 진척 없음이다.
 */
export function noProgress(recent: string[]): boolean {
  const last = recent.slice(-3).map(parse).filter((p): p is NonNullable<typeof p> => p !== null);
  if (last.length === 0) return false;
  const latest = last[last.length - 1]!;
  const earlierErrored = last.slice(0, -1).some((p) => p.err !== '-');
  if (latest.err === '-' && earlierErrored) return false;
  const errs = last.map((p) => p.err).filter((e) => e !== '-');
  if (new Set(errs).size < errs.length) return true;
  return last.length === 3 && last.every((p) => p.changed === 0 && p.tests === last[0]!.tests);
}

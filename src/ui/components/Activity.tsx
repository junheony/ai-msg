import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { TaskStatus, TurnPhase } from '../../shared/turn-types';
import type { AgentInfo, ChatItem, PaneBackground, ToolCallItem } from '../state';
import { toolLabel } from '../toolLabel';
import { ProgressMark } from './BrandMark';
import { usePrefs } from '../usePrefs';
import { conciseAck } from '../../shared/concise';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

/** Date.now(), re-read every `ms` while `active` — the only ticking state; kept inside the small components that show time. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** m:ss (h:mm:ss past an hour). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How long ago, coarsely: 방금 (under 5 s), N초 전, N분 전, N시간 전. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

/** 950 → "950", 1234 → "1.2k", 25300 → "25k". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const clip = (s: string, n = 40) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Present-tense verb and a short argument for a running tool call (status row). */
export function toolVerb(call: Pick<ToolCallItem, 'name' | 'input'>): { verb: string; arg: string } {
  const i = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const file = s('file_path') || s('path') || s('notebook_path');
  switch (call.name) {
    case 'Read': return { verb: '파일 읽는 중', arg: file ? base(file) : '' };
    case 'Bash': return { verb: '명령 실행 중', arg: clip(s('description') || s('command')) };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return { verb: '파일 수정 중', arg: file ? base(file) : '' };
    case 'Grep': case 'Glob': return { verb: '검색 중', arg: clip(s('pattern')) };
    case 'Agent': case 'Task': return { verb: '에이전트 실행 중', arg: clip(s('description') || s('subagent_type')) };
    case 'WebSearch': return { verb: '웹 검색 중', arg: clip(s('query')) };
    case 'WebFetch': return { verb: '웹 페이지 가져오는 중', arg: clip(s('url')) };
    case 'TodoWrite': return { verb: '할 일 정리 중', arg: '' };
    default: return { verb: '작업 중', arg: call.name.startsWith('mcp__') ? call.name.split('__').slice(1).join(' · ') : call.name };
  }
}

const PHASE_VERB: Record<TurnPhase, string> = { thinking: '생각 중…', responding: '응답 작성 중…', tool: '도구 준비 중…' };
const IDLE_VERBS = ['생각 중…', '작업 중…', '살펴보는 중…', '정리하는 중…'];

/**
 * Desktop-style live line above the composer while a turn runs: spinner, what it is doing now, m:ss,
 * output tokens, tool count and a stop button. Owns the 1s timer so nothing else re-renders per tick.
 */
export function StatusRow({ startedAt, started, queuedBehind = null, progress, live, onInterrupt, onCancel, routeAck = null }: {
  startedAt: number | null;
  /** turn_started arrived (false = 시작하는 중…). */
  started: boolean;
  /** Not started because the server holds the send behind a streaming segment (its reason, e.g. 백그라운드 계속). */
  queuedBehind?: string | null;
  progress: { outputTokens: number; phase: TurnPhase } | null;
  live: Assistant | null;
  onInterrupt?: () => void;
  /** 시작하는 중…: stop waiting for the turn (there is nothing to interrupt yet, so 중단 cannot help). */
  onCancel?: () => void;
  /** Concise-mode ack: model/engine/account once turn_started is known. */
  routeAck?: { model?: string | null; engine?: string | null; accountLabel?: string | null; step?: string | null } | null;
}) {
  const now = useNow(true);
  const [prefs] = usePrefs();
  const concise = prefs.conciseMode;
  const ms = startedAt === null ? 0 : now - startedAt;
  const running = live ? live.toolCalls.findLast((c) => c.result === null) : undefined;
  const tool = running ? toolVerb(running) : null;
  const tools = live ? live.toolCalls.length : 0;
  let verb: string;
  if (!started) {
    verb = queuedBehind ? `${queuedBehind} 뒤에서 기다리는 중 — 끝나면 이어서 보냄` : (concise ? '확인…' : '시작하는 중…');
  } else if (concise) {
    // Instant short ack naming the chosen engine/model; then milestone-style progress.
    if (tools > 0 && ms >= 15_000) verb = `계속 작업 중 · 단계 ${tools}`;
    else if (routeAck) verb = conciseAck({ model: routeAck.model, engine: routeAck.engine as 'claude' | 'codex' | 'gemini' | 'grok' | null, accountLabel: routeAck.accountLabel, step: routeAck.step ?? null });
    else verb = '확인 · 처리 중';
  } else {
    verb = tool ? tool.verb : progress ? PHASE_VERB[progress.phase] : IDLE_VERBS[Math.floor(ms / 6000) % IDLE_VERBS.length]!;
  }
  return (
    <div className={`turn-status${concise ? ' concise' : ''}`} role="status" data-testid="turn-status">
      <ProgressMark className="spark spin" />
      <span className="status-verb">{verb}</span>
      {!concise && tool?.arg && <code className="status-arg" title={tool.arg}>{tool.arg}</code>}
      <span className="status-meta">
        <span>{clock(ms)}</span>
        {!concise && progress && progress.outputTokens > 0 && <span className="status-tokens"><span className="sep">·</span><span title="출력 토큰">↓ {tokens(progress.outputTokens)}<span className="status-unit"> 토큰</span></span></span>}
        {!concise && tools > 0 && <span className="status-tools"><span className="sep">·</span><span>도구 {tools}회</span></span>}
      </span>
      {started && onInterrupt && <button type="button" className="status-stop" onClick={onInterrupt} title="중단 (Esc)">중단</button>}
      {!started && onCancel && <button type="button" className="status-stop" onClick={onCancel} title="기다리지 않고 입력창으로 되돌립니다">취소</button>}
    </div>
  );
}

/** Subagent cards read live agent state from here, so MessageView's memo holds while agents update. */
export type AgentCtx = { agents: Record<string, AgentInfo>; bgLive: boolean; /** the pane has a turn running */ active: boolean };
export const AgentContext = createContext<AgentCtx>({ agents: {}, bgLive: false, active: false });

const STATUS_TEXT: Record<TaskStatus, string> = { running: '실행 중', completed: '완료', failed: '실패', stopped: '중단됨' };

/**
 * What an Agent/Task call's card shows: the call's own result wins; live subagent state fills in the rest.
 * `live`: the call's item streams, or (opened mid-turn: the call sits in the reloaded transcript) the pane's turn runs.
 */
export function agentStatus(call: ToolCallItem, info: AgentInfo | undefined, live: boolean, bgLive: boolean): TaskStatus {
  if (call.isError) return 'failed';
  if (info?.backgrounded) return info.status === 'running' && !live && !bgLive ? 'completed' : info.status;
  if (call.result === null) return info && info.status !== 'running' ? info.status : live ? 'running' : 'stopped';
  return info?.status === 'failed' ? 'failed' : 'completed';
}

const SHOW_CALLS = 5;

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

/** One Agent/Task call: type and description, live timer/tokens, its last few tool calls, then ✓/✗ and duration. */
export function AgentCard({ call, live }: { call: ToolCallItem; live: boolean }) {
  const { agents, bgLive, active } = useContext(AgentContext);
  const info = agents[call.toolUseId];
  const status = agentStatus(call, info, live || (active && !!info), bgLive);
  const running = status === 'running';
  const now = useNow(running && !!info);
  const [all, setAll] = useState(false);
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  const type = info?.subagentType || (typeof input.subagent_type === 'string' ? input.subagent_type : '') || '에이전트';
  const desc = info?.description || (typeof input.description === 'string' ? input.description : '');
  const ms = info ? (info.usage && !running ? info.usage.durationMs : (info.endedAt ?? now) - info.startedAt) : null;
  const calls = info?.calls ?? [];
  const shown = all ? calls : calls.slice(-SHOW_CALLS);
  const icon = running ? <ProgressMark className="spark spin" /> : status === 'completed' ? <span className="agent-mark ok" aria-hidden="true">✓</span> : status === 'failed' ? <span className="agent-mark err" aria-hidden="true">✗</span> : <span className="agent-mark" aria-hidden="true">■</span>;
  return (
    <div className={`agent-card ${status}`} data-testid="agent-card">
      <div className="agent-head">
        {icon}
        <span className="agent-type">{type}</span>
        <span className="agent-desc" title={desc}>{desc}</span>
        {info?.backgrounded && <span className="agent-badge">백그라운드</span>}
        <span className="agent-meta">
          {ms !== null && <span>{clock(ms)}</span>}
          {info?.usage && info.usage.totalTokens > 0 && <span>{tokens(info.usage.totalTokens)} 토큰</span>}
          {!running && <span className={`agent-status ${status}`}>{STATUS_TEXT[status]}</span>}
        </span>
      </div>
      {calls.length > 0 && (
        <ul className="agent-calls">
          {!all && calls.length > SHOW_CALLS && (
            <li><button type="button" className="agent-more" onClick={() => setAll(true)}>+{calls.length - SHOW_CALLS}개 더 보기</button></li>
          )}
          {shown.map((c) => (
            <li key={c.toolUseId} className={c.isError ? 'error' : c.done ? 'done' : 'running'}>
              <span className="agent-call-mark" aria-hidden="true">{c.isError ? '✗' : c.done ? '✓' : '…'}</span>
              <span className="tool-label">{toolLabel({ ...c, result: null })}</span>
            </li>
          ))}
        </ul>
      )}
      {running && calls.length === 0 && info?.lastToolName && <div className="agent-last muted">{info.lastToolName}</div>}
      {(call.result !== null || typeof input.prompt === 'string') && (
        <details className="agent-detail">
          <summary><span className="tool-label">{call.result !== null ? '결과 보기' : '지시 보기'}</span><span className="tool-caret" aria-hidden="true">›</span></summary>
          <div className="tool-detail">
            {typeof input.prompt === 'string' && <pre className="tool-input">{pretty(input.prompt)}</pre>}
            {call.result !== null && <pre className="tool-output">{pretty(call.result)}</pre>}
          </div>
        </details>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { local_bash: '명령', local_agent: '에이전트', mcp_task: 'MCP', local_workflow: '워크플로', remote_agent: '원격 에이전트' };

/**
 * "백그라운드 작업 N개 · m:ss" pill with a pulsing dot — the clock is the oldest task's run time (or, without per-task
 * detail, how long the pill has been up) and ticks while the pill is closed too, so a long hold reads as alive rather
 * than stuck; click opens the task list (each with its age, status and 중지 when the process can stop one task) and
 * 모두 중지.
 */
export function BackgroundPill({ bg, onStopTask, onStopAll }: { bg: PaneBackground; onStopTask?: (taskId: string) => void; onStopAll: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const rows = bg.detail.length ? bg.detail.map((d) => ({ id: d.id, description: d.description, type: d.type, ms: now - bg.receivedAt + d.ageMs })) : bg.tasks.map((t, i) => ({ id: null as string | null, description: t, type: '', ms: null as number | null, key: i }));
  const n = rows.length;
  const oldestMs = bg.detail.length ? now - bg.receivedAt + Math.max(...bg.detail.map((d) => d.ageMs)) : now - bg.receivedAt;
  const last = bg.last;
  // Tense-free (the call may be over, or still running after minutes): "Bash cast call 0x5d…", "Read lib.ts".
  const lastText = !last ? '' : last.kind === 'task' ? last.text : (({ arg }) => (arg ? `${last.name} ${arg}` : last.name))(toolVerb({ name: last.name, input: last.input }));
  const seen = last ? (now - last.at < 5_000 ? '방금 활동' : `활동 ${ago(now - last.at)}`) : '';
  return (
    <div className="bg-pill-wrap" ref={ref}>
      <button type="button" className={`bg-pill ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" data-testid="bg-pill" title={lastText || undefined}>
        <span className="pulse-dot" aria-hidden="true" />
        <span className="bg-pill-label"><span className="bg-pill-word">백그라운드</span><span className="bg-pill-long"> 작업</span> {n}개<span className="bg-pill-clock"> · {clock(oldestMs)}</span>{seen && <span className="bg-pill-seen"> · {seen}</span>}</span>
      </button>
      {open && (
        <div className="bg-popover" role="dialog" aria-label="백그라운드 작업" data-testid="bg-popover">
          <div className="bg-pop-head">백그라운드 작업 {n}개</div>
          {seen && <div className="bg-pop-seen" title={lastText}>마지막 {seen}{lastText ? ` · ${lastText}` : ''}</div>}
          <ul className="bg-list">
            {rows.map((r, i) => (
              <li key={r.id ?? i}>
                <span className="pulse-dot" aria-hidden="true" />
                <span className="bg-desc" title={r.description}>{r.description || '작업'}</span>
                <span className="bg-sub">
                  {r.type && <span>{TYPE_LABEL[r.type] ?? r.type}</span>}
                  {r.ms !== null && <span>{clock(r.ms)}</span>}
                  <span>실행 중</span>
                </span>
                {bg.canStop && r.id && onStopTask && <button type="button" className="btn ghost bg-stop-one" onClick={() => onStopTask(r.id!)}>중지</button>}
              </li>
            ))}
          </ul>
          <div className="bg-pop-foot">
            <button type="button" className="btn ghost bg-stop-all" onClick={() => { setOpen(false); onStopAll(); }}>모두 중지</button>
          </div>
        </div>
      )}
    </div>
  );
}

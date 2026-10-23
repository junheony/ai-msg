import { useContext, useMemo, useState, type ReactNode } from 'react';
import { fileDiffsFor, relPath } from '../diff';
import { formatNumber, ui } from '../i18n';
import { SidePanelContext } from '../sidePanel';
import type { ToolCallItem } from '../state';
import { groupLabel, toolLabel } from '../toolLabel';
import { applyTodoCall, todoCounts } from '../todos';
import { FULL_CHARS, TAIL_CHARS, TAIL_LINES, canonicalTool, inputView, outputView, tailOf, type OutputView } from '../toolView';
import { TodoList } from './TodoPanel';
import { DiffList } from './DiffView';
import { AgentCard } from './Activity';
import { CopyButton } from './CopyButton';
import { QuestionSummary, askedOf } from './QuestionSummary';

const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** What a tool card's copy button copies: the shell command itself when there is one, else the full (uncut) value. */
function copyable(v: unknown): string {
  if (v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string') return (v as { command: string }).command;
  return json(v);
}

function stateOf(call: ToolCallItem, live: boolean): { cls: string; text: string } {
  if (call.isError) return { cls: 'error', text: ui().tool.error };
  if (call.result === null && live) return { cls: 'running', text: ui().tool.running };
  return { cls: '', text: '' };
}

const clipEnd = (s: string) => (s.length > FULL_CHARS ? `${s.slice(0, FULL_CHARS)}\n…` : s);

/** The call's output as shown, worked out once per result (a live result can be megabytes, re-rendered per token). */
const useOutput = (call: ToolCallItem): OutputView | null =>
  useMemo(() => (call.result === null ? null : outputView(call.result, call.name, call.isError)), [call.result, call.name, call.isError]);

/** The exit code a failed call's output names (Claude "Exit code N", Grok "exit: N"); null when none or it succeeded. */
function failedExit(o: OutputView | null, isError: boolean): number | null {
  const code = o?.exitCode ?? null;
  return code !== null && (isError || code !== 0) ? code : null;
}

const ExitChip = ({ code }: { code: number }) => <span className="tool-chip error">{ui().tool.exitCode(code)}</span>;

/** One part of an opened call (input / output): a header line with its label, chips and copy button, then the body. */
function Section({ label, extra, copy, copyLabel, className, children }: { label: string; extra?: ReactNode; copy: () => string; copyLabel: string; className?: string; children: ReactNode }) {
  return (
    <div className={`tool-sec${className ? ` ${className}` : ''}`}>
      <div className="tool-sec-head">
        <span className="tool-sec-label">{label}</span>
        {extra}
        <span className="grow" />
        <CopyButton icon text={copy} label={copyLabel} className="tool-copy" />
      </div>
      {children}
    </div>
  );
}

/** The call's input as people read it: `$ command`, the file relative to the session folder, short key: value lines; raw JSON folded. */
/** The raw input JSON, folded: built only while open, and cut at FULL_CHARS (a Write's whole file can be in it). */
function RawInput({ input }: { input: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="tool-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{ui().tool.raw}</summary>
      {open && <pre>{clipEnd(json(input))}</pre>}
    </details>
  );
}

function ToolInput({ call, cwd }: { call: ToolCallItem; cwd?: string | null }) {
  const T = ui().tool;
  const v = inputView(call.name, call.input, cwd);
  const raw = v.kind !== 'raw' && <RawInput input={call.input} />;
  const fields = v.kind !== 'raw' && v.fields.length > 0 && (
    <dl className="tool-fields">
      {v.fields.map((f) => <div key={f.key}><dt>{f.key}</dt><dd>{f.value}</dd></div>)}
    </dl>
  );
  if (v.kind === 'command') {
    return (
      <Section label={T.command} copy={() => v.command} copyLabel={T.copyCommand}>
        <pre className="tool-input tool-cmd"><span className="tool-prompt" aria-hidden="true">$ </span>{v.command}</pre>
        {fields}
        {raw}
      </Section>
    );
  }
  if (v.kind === 'fields' && !v.path && v.fields.length === 0) return null;
  return (
    <Section label={T.input} copy={() => copyable(call.input)} copyLabel={T.copyInput}>
      {v.kind === 'raw' ? <pre className="tool-input">{clipEnd(v.text)}</pre> : (
        <>
          {v.path && <div className="tool-path">{v.path}</div>}
          {fields}
          {raw}
        </>
      )}
    </Section>
  );
}

/**
 * The call's output: its last TAIL_LINES lines with "전체 보기", saying what was left out (here, or by the server's cut);
 * a failed call's exit code as a chip.
 */
function ToolOutput({ call, o }: { call: ToolCallItem & { result: string }; o: OutputView }) {
  const T = ui().tool;
  const [full, setFull] = useState(false);
  const exit = failedExit(o, call.isError);
  const short = useMemo(() => tailOf(o.text, TAIL_LINES, TAIL_CHARS), [o.text]);
  const whole = useMemo(() => (full ? tailOf(o.text, Number.POSITIVE_INFINITY, FULL_CHARS) : null), [o.text, full]);
  const cuttable = short.hiddenLines > 0 || short.hiddenChars > 0;
  const shown = whole ?? short;
  // Folding a long output back: if its header went above the screen, bring it back instead of leaving the reader lost.
  const toggle = (btn: HTMLElement) => {
    setFull(!full);
    if (!full) return;
    requestAnimationFrame(() => {
      const head = btn.closest('.tool-sec');
      if (head && head.getBoundingClientRect().top < 0) head.scrollIntoView({ block: 'start' });
    });
  };
  if (!o.text && exit === null && !o.serverCut && !call.isError) return null;
  return (
    <Section label={T.output} extra={exit !== null && <ExitChip code={exit} />} copy={() => call.result} copyLabel={T.copyOutput} className="out">
      {(shown.hiddenLines > 0 || shown.hiddenChars > 0) && (
        <div className="tool-note">{shown.hiddenLines > 0 ? T.hiddenLines(shown.hiddenLines) : T.hiddenChars(formatNumber(shown.hiddenChars))}</div>
      )}
      <pre className={`tool-output${full ? ' full' : ''}`}>{shown.text || <span className="tool-empty">{T.noOutput}</span>}</pre>
      {o.serverCut && <div className="tool-note cut">{T.serverCut(formatNumber(o.serverCut.shown), formatNumber(o.serverCut.total))}</div>}
      {cuttable && (
        <button type="button" className="tool-btn tool-more" aria-expanded={full} onClick={(e) => toggle(e.currentTarget)}>
          {full ? T.showTail(TAIL_LINES) : T.showAll(short.lineCount)}
        </button>
      )}
    </Section>
  );
}

/**
 * A file-editing call (Edit / MultiEdit / Write / NotebookEdit, Codex file change) as diff cards, closed to their header
 * lines (path · 새 파일 · +N −M) until clicked; null for any other call.
 */
function DiffToolCall({ call, live, cwd, o }: { call: ToolCallItem; live: boolean; cwd?: string | null; o: OutputView | null }) {
  const diffs = diffsOf(call);
  if (!diffs) return null;
  const st = stateOf(call, live);
  return (
    <div className={`tool-call diff-call ${st.cls}`} data-testid="tool-call">
      <DiffList diffs={diffs} cwd={cwd} folded {...(st.text ? { state: st.text } : {})} />
      {call.isError && call.result && o && <div className="tool-detail"><ToolOutput call={{ ...call, result: call.result }} o={o} /></div>}
    </div>
  );
}

/** Other engines' file writes (Grok write / search_replace, Gemini write_file / replace) count as the Claude tool they match. */
const diffsOf = (c: ToolCallItem) => fileDiffsFor(canonicalTool(c.name), c.input, c.result);
const isDiffCall = (c: ToolCallItem) => diffsOf(c) !== null;
export const isAgentCall = (c: ToolCallItem) => c.name === 'Agent' || c.name === 'Task';
/** File edits (diff cards) and subagent calls (agent cards) stay out in the reply; other calls fold into its meta line. */
export const isSoloCall = (c: ToolCallItem) => isAgentCall(c) || isDiffCall(c) || isQuestionCall(c);
/** An answered (or refused) AskUserQuestion: shown in the reply as its `question → answer` summary, in 간결 모드 too. */
export const isQuestionCall = (c: ToolCallItem) => c.name === 'AskUserQuestion' && c.result !== null && askedOf(c.input).length > 0;

/** The file a Read call looked at (a Read of a missing file still offers the panel; it shows the error). */
function readPath(call: ToolCallItem): string | null {
  const p = call.name === 'Read' && call.input && typeof call.input === 'object' ? (call.input as { file_path?: unknown }).file_path : null;
  return typeof p === 'string' && p ? p : null;
}

/** One tool call = one muted line; click to see its input and output. File edits render as diff cards. */
export function ToolCallView({ call, live = false, cwd }: { call: ToolCallItem; live?: boolean; cwd?: string | null }) {
  const open = useContext(SidePanelContext);
  const o = useOutput(call);
  const st = stateOf(call, live);
  if (isDiffCall(call)) return <DiffToolCall call={call} live={live} cwd={cwd} o={o} />;
  // ux-state: a TodoWrite shows its checklist, not raw JSON.
  const todos = call.name === 'TodoWrite' ? applyTodoCall(null, call) : null;
  const file = readPath(call);
  const exit = failedExit(o, call.isError);
  return (
    <details className={`tool-call ${st.cls || (exit !== null ? 'error' : '')}`} data-testid="tool-call">
      <summary title={call.name}>
        <span className="tool-label">{toolLabel(call)}</span>
        {todos && todos.length > 0 && <span className="tool-state todo-count">{todoCounts(todos).done}/{todos.length}</span>}
        {exit !== null ? <ExitChip code={exit} /> : st.text && <span className="tool-state">{st.text}</span>}
        {open && file && (
          <button type="button" className="file-link tool-open" title={`${file} — 사이드 패널에서 열기`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open({ kind: 'file', path: file }); }}>
            {relPath(file, cwd)}
          </button>
        )}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      {todos ? (
        <div className="tool-detail todo-detail"><TodoList todos={todos} /></div>
      ) : (
        <div className="tool-detail">
          <ToolInput call={call} cwd={cwd} />
          {call.result !== null && o && <ToolOutput call={{ ...call, result: call.result }} o={o} />}
        </div>
      )}
    </details>
  );
}

/** File edits and subagent (Agent/Task) calls stand alone (solo); runs of other calls group, in order. */
export function toolSegments(calls: ToolCallItem[]): { solo: boolean; calls: ToolCallItem[] }[] {
  const segments: { solo: boolean; calls: ToolCallItem[] }[] = [];
  for (const c of calls) {
    const solo = isSoloCall(c);
    const last = segments.at(-1);
    if (last && !solo && !last.solo) last.calls.push(c);
    else segments.push({ solo, calls: [c] });
  }
  return segments;
}

/**
 * A turn's tool calls in order: file edits as their own diff cards and subagent calls as agent cards (Desktop style); each run of other calls
 * as one line alone, or one collapsed group line ("실행된 명령 5개 ›") for several.
 */
export function ToolCalls({ calls, live = false, cwd, flat = false }: { calls: ToolCallItem[]; live?: boolean; cwd?: string | null; /** Inside a 작업 기록 fold: one line per call, no group line of its own. */ flat?: boolean }) {
  if (calls.length === 0) return null;
  if (flat) return <>{calls.map((c) => (isAgentCall(c) ? <AgentCard key={c.toolUseId} call={c} live={live} /> : <ToolCallView key={c.toolUseId} call={c} live={live} cwd={cwd} />))}</>;
  const segments = toolSegments(calls);
  if (segments.length > 1) return <>{segments.map((s) => <ToolCalls key={s.calls[0]!.toolUseId} calls={s.calls} live={live} cwd={cwd} />)}</>;
  if (isAgentCall(calls[0]!)) return <AgentCard call={calls[0]!} live={live} />;
  if (isQuestionCall(calls[0]!)) return <QuestionSummary call={calls[0]!} />;
  if (segments[0]!.solo) return <ToolCallView call={calls[0]!} live={live} cwd={cwd} />;
  if (calls.length === 1) return <ToolCallView call={calls[0]!} live={live} cwd={cwd} />;
  const running = live && calls.some((c) => c.result === null);
  const errors = calls.filter((c) => c.isError).length;
  return (
    <details className={`tool-group ${running ? 'running' : ''}`} data-testid="tool-group">
      <summary>
        <span className="tool-label">{groupLabel(calls)}</span>
        {running && <span className="tool-state">{ui().tool.running}</span>}
        {errors > 0 && <span className="tool-state error">{ui().chat.meta.errors(errors)}</span>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      <div className="tool-group-list">
        {calls.map((c) => <ToolCallView key={c.toolUseId} call={c} live={live} cwd={cwd} />)}
      </div>
    </details>
  );
}

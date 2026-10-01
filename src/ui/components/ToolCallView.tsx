import { fileDiffsFor } from '../diff';
import type { ToolCallItem } from '../state';
import { groupLabel, toolLabel } from '../toolLabel';
import { DiffList } from './DiffView';

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

function stateOf(call: ToolCallItem, live: boolean): { cls: string; text: string } {
  if (call.isError) return { cls: 'error', text: '오류' };
  if (call.result === null && live) return { cls: 'running', text: '실행 중…' };
  return { cls: '', text: '' };
}

/** A file-editing call (Edit / MultiEdit / Write / NotebookEdit, Codex file change) as diff cards; null for any other call. */
function DiffToolCall({ call, live, cwd }: { call: ToolCallItem; live: boolean; cwd?: string | null }) {
  const diffs = fileDiffsFor(call.name, call.input, call.result);
  if (!diffs) return null;
  const st = stateOf(call, live);
  return (
    <div className={`tool-call diff-call ${st.cls}`} data-testid="tool-call">
      <DiffList diffs={diffs} cwd={cwd} {...(st.text ? { state: st.text } : {})} />
      {call.isError && call.result && <pre className="tool-output">{pretty(call.result)}</pre>}
    </div>
  );
}

const isDiffCall = (c: ToolCallItem) => fileDiffsFor(c.name, c.input, c.result) !== null;

/** One tool call = one muted line; click to see its input and output. File edits render as diff cards. */
export function ToolCallView({ call, live = false, cwd }: { call: ToolCallItem; live?: boolean; cwd?: string | null }) {
  const st = stateOf(call, live);
  if (isDiffCall(call)) return <DiffToolCall call={call} live={live} cwd={cwd} />;
  return (
    <details className={`tool-call ${st.cls}`} data-testid="tool-call">
      <summary title={call.name}>
        <span className="tool-label">{toolLabel(call)}</span>
        {st.text && <span className="tool-state">{st.text}</span>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      <div className="tool-detail">
        <pre className="tool-input">{pretty(call.input)}</pre>
        {call.result !== null && <pre className="tool-output">{pretty(call.result)}</pre>}
      </div>
    </details>
  );
}

/**
 * A turn's tool calls in order: file edits as their own diff cards (Desktop style); each run of other calls
 * as one line alone, or one collapsed group line ("실행된 명령 5개 ›") for several.
 */
export function ToolCalls({ calls, live = false, cwd }: { calls: ToolCallItem[]; live?: boolean; cwd?: string | null }) {
  if (calls.length === 0) return null;
  const segments: { diff: boolean; calls: ToolCallItem[] }[] = [];
  for (const c of calls) {
    const diff = isDiffCall(c);
    const last = segments.at(-1);
    if (last && !diff && !last.diff) last.calls.push(c);
    else segments.push({ diff, calls: [c] });
  }
  if (segments.length > 1) return <>{segments.map((s) => <ToolCalls key={s.calls[0]!.toolUseId} calls={s.calls} live={live} cwd={cwd} />)}</>;
  if (segments[0]!.diff) return <ToolCallView call={calls[0]!} live={live} cwd={cwd} />;
  if (calls.length === 1) return <ToolCallView call={calls[0]!} live={live} />;
  const running = live && calls.some((c) => c.result === null);
  const errors = calls.filter((c) => c.isError).length;
  return (
    <details className={`tool-group ${running ? 'running' : ''}`} data-testid="tool-group">
      <summary>
        <span className="tool-label">{groupLabel(calls)}</span>
        {running && <span className="tool-state">실행 중…</span>}
        {errors > 0 && <span className="tool-state error">오류 {errors}</span>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      <div className="tool-group-list">
        {calls.map((c) => <ToolCallView key={c.toolUseId} call={c} live={live} />)}
      </div>
    </details>
  );
}

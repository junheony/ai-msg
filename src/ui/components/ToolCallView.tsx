import type { ToolCallItem } from '../state';
import { groupLabel, toolLabel } from '../toolLabel';
import { applyTodoCall, todoCounts } from '../todos';
import { TodoList } from './TodoPanel';

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

function stateOf(call: ToolCallItem, live: boolean): { cls: string; text: string } {
  if (call.isError) return { cls: 'error', text: '오류' };
  if (call.result === null && live) return { cls: 'running', text: '실행 중…' };
  return { cls: '', text: '' };
}

/** One tool call = one muted line; click to see its input and output. */
export function ToolCallView({ call, live = false }: { call: ToolCallItem; live?: boolean }) {
  const st = stateOf(call, live);
  // ux-state: a TodoWrite shows its checklist, not raw JSON.
  const todos = call.name === 'TodoWrite' ? applyTodoCall(null, call) : null;
  return (
    <details className={`tool-call ${st.cls}`} data-testid="tool-call">
      <summary title={call.name}>
        <span className="tool-label">{toolLabel(call)}</span>
        {todos && todos.length > 0 && <span className="tool-state todo-count">{todoCounts(todos).done}/{todos.length}</span>}
        {st.text && <span className="tool-state">{st.text}</span>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      {todos ? (
        <div className="tool-detail todo-detail"><TodoList todos={todos} /></div>
      ) : (
        <div className="tool-detail">
          <pre className="tool-input">{pretty(call.input)}</pre>
          {call.result !== null && <pre className="tool-output">{pretty(call.result)}</pre>}
        </div>
      )}
    </details>
  );
}

/** A turn's tool calls: one line alone, or one collapsed group line ("실행된 명령 5개 ›") for several. */
export function ToolCalls({ calls, live = false }: { calls: ToolCallItem[]; live?: boolean }) {
  if (calls.length === 0) return null;
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

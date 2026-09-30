import type { ToolCallItem } from '../state';

function pretty(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + '\n…' : s;
}

export function ToolCallView({ call }: { call: ToolCallItem }) {
  return (
    <details className={`tool-call ${call.isError ? 'error' : ''}`}>
      <summary>
        <span className="tool-name">{call.name}</span>
        <span className="tool-state">{call.result === null ? '실행 중…' : call.isError ? '오류' : '완료'}</span>
      </summary>
      <pre className="tool-input">{pretty(call.input)}</pre>
      {call.result !== null && <pre className="tool-output">{pretty(call.result)}</pre>}
    </details>
  );
}

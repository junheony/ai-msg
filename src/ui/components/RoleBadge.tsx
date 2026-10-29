import { useContext, useState } from 'react';
import type { TaskStatus } from '../../shared/turn-types';
import { roleStatus, type RoleEntry } from '../roles';
import type { AgentInfo } from '../state';
import { AgentContext, agentStatus, clock, useNow } from './Activity';

const STATUS_TEXT: Record<TaskStatus, string> = { running: '실행 중', completed: '완료', failed: '실패', stopped: '중단됨' };

function elapsedMs(info: AgentInfo | undefined, running: boolean, now: number): number | null {
  if (!info) return null;
  if (info.usage && !running) return info.usage.durationMs;
  return (info.endedAt ?? now) - info.startedAt;
}

/** D9: a collapsed count that opens into one row per subagent or offload. */
export function RoleBadge({ roles, live = false }: { roles: RoleEntry[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const { agents, bgLive, active } = useContext(AgentContext);
  const anyRunning = roles.some((r) => {
    if (r.kind !== 'agent') return r.pending && live;
    const info = agents[r.toolUseId];
    return agentStatus({ toolUseId: r.toolUseId, name: 'Agent', input: {}, result: r.pending ? null : '', isError: r.isError }, info, live || (active && !!info), bgLive) === 'running';
  });
  const now = useNow(open && anyRunning);
  if (!roles.length) return null;
  const agentCount = roles.filter((r) => r.kind === 'agent').length;
  const offloads = roles.length - agentCount;
  return (
    <div className="role-badge">
      <button type="button" className="role-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {`서브에이전트 ${agentCount} · offload ${offloads}`}
      </button>
      {open && (
        <ul className="role-list" data-testid="role-list">
          {roles.map((r) => {
            const info = r.kind === 'agent' ? agents[r.toolUseId] : undefined;
            const status = r.kind === 'agent'
              ? agentStatus({ toolUseId: r.toolUseId, name: 'Agent', input: {}, result: r.pending ? null : '', isError: r.isError }, info, live || (active && !!info), bgLive)
              : roleStatus(r, live);
            const running = status === 'running';
            const ms = r.kind === 'agent' ? elapsedMs(info, running, now) : null;
            const title = r.kind === 'agent' ? r.description : r.command;
            const kind = r.kind === 'agent' ? r.type : `offload ${r.cross ? 'cross' : (r.model ?? '자동')}`;
            const model = r.model ?? (r.kind === 'agent' ? '기본 모델' : '');
            return (
              <li key={r.toolUseId} className={`role-row ${status}`} title={title}>
                <span className="role-kind">{kind}</span>
                {title && <span className="role-desc">{title}</span>}
                {model && <span className="role-model">{model}</span>}
                <span className="role-status">{STATUS_TEXT[status]}</span>
                {ms !== null && <span className="role-elapsed">{clock(ms)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

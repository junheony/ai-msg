import { ui } from '../i18n';
import type { RoleEntry } from '../roles';

/** D9 role distribution, folded: "서브에이전트 3 · offload 1" for the turn's meta line; null when nobody else worked. */
export function roleCountLabel(roles: RoleEntry[]): string | null {
  if (!roles.length) return null;
  const T = ui().chat.roles;
  const agents = roles.filter((r) => r.kind === 'agent').length;
  const offloads = roles.length - agents;
  return [agents ? T.agents(agents) : null, offloads ? T.offloads(offloads) : null].filter(Boolean).join(' · ');
}

/** The role chips the folded label opens to: one per subagent (type · model) or offload run. */
export function RoleBadge({ roles }: { roles: RoleEntry[] }) {
  if (!roles.length) return null;
  const T = ui().chat.roles;
  return (
    <div className="role-badge">
      {roles.map((r, i) => r.kind === 'agent'
        ? <span key={i} className="chip agent" title={r.description}>{r.type} · {r.model ?? T.defaultModel}</span>
        : <span key={i} className="chip offload" title={r.command}>offload {r.cross ? 'cross' : (r.model ?? T.auto)}</span>)}
    </div>
  );
}

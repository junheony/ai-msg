import type { ReactElement } from 'react';
import type { StudioAgent } from '../../../shared/hub-types';

/**
 * A crew member's face, drawn (no image assets): each account has its own head shape and colour so a glance tells
 * who is who — Claude a (round, antenna), b (visor), c (hexagon), Codex (terminal screen). The ring around it is the
 * state: a turning accent arc while working, a quiet solid ring when finished, red only when the owner is needed,
 * amber when blocked or stopped, dotted grey when idle.
 */
const FACES: Record<StudioAgent['account'], ReactElement> = {
  a: (
    <g>
      <line x1="24" y1="7" x2="24" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="6" r="2.4" fill="currentColor" />
      <circle cx="24" cy="26" r="13" fill="currentColor" />
      <circle cx="19" cy="25" r="2.6" fill="var(--gs-face-ink)" />
      <circle cx="29" cy="25" r="2.6" fill="var(--gs-face-ink)" />
      <path d="M19.5 31.5q4.5 3 9 0" stroke="var(--gs-face-ink)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </g>
  ),
  b: (
    <g>
      <rect x="11" y="12" width="26" height="25" rx="7" fill="currentColor" />
      <rect x="14.5" y="19" width="19" height="8" rx="4" fill="var(--gs-face-ink)" />
      <rect x="17.5" y="21.5" width="4" height="3" rx="1.5" fill="currentColor" />
      <rect x="26.5" y="21.5" width="4" height="3" rx="1.5" fill="currentColor" />
      <rect x="20" y="31" width="8" height="2.4" rx="1.2" fill="var(--gs-face-ink)" />
      <rect x="8" y="20" width="3" height="8" rx="1.5" fill="currentColor" />
      <rect x="37" y="20" width="3" height="8" rx="1.5" fill="currentColor" />
    </g>
  ),
  c: (
    <g>
      <path d="M24 10l13 7.5v15L24 40l-13-7.5v-15z" fill="currentColor" />
      <path d="M17 24l4-2.5M31 24l-4-2.5" stroke="var(--gs-face-ink)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="19.5" cy="26.5" r="2.2" fill="var(--gs-face-ink)" />
      <circle cx="28.5" cy="26.5" r="2.2" fill="var(--gs-face-ink)" />
      <path d="M21 32h6" stroke="var(--gs-face-ink)" strokeWidth="2" strokeLinecap="round" />
    </g>
  ),
  codex: (
    <g>
      <rect x="9" y="12" width="30" height="22" rx="4" fill="currentColor" />
      <rect x="12" y="15" width="24" height="16" rx="2" fill="var(--gs-face-ink)" />
      <path d="M16 20l3.5 3-3.5 3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="22" y="25" width="8" height="2" rx="1" fill="currentColor" />
      <rect x="19" y="35" width="10" height="3" rx="1" fill="currentColor" />
    </g>
  ),
  unknown: (
    <g>
      <circle cx="24" cy="25" r="13" fill="currentColor" />
      <text x="24" y="30" textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--gs-face-ink)">?</text>
    </g>
  ),
};

export const agentName = (a: Pick<StudioAgent, 'account'>): string => (a.account === 'codex' ? 'Codex' : a.account === 'unknown' ? '에이전트' : `Claude ${a.account}`);
export const AGENT_STATE_LABEL: Record<StudioAgent['state'], string> = { working: '작업 중', 'needs-owner': '승인 필요', blocked: '막힘', stopped: '중단됨', superseded: '이어받음', done: '완료', idle: '대기' };
export const agentStateText = (a: Pick<StudioAgent, 'state' | 'successor'>): string => (a.state === 'superseded' && a.successor ? `이어받음 → ${a.successor}` : AGENT_STATE_LABEL[a.state]);

export function AgentAvatar({ account, state, size = 56, title }: { account: StudioAgent['account']; state: StudioAgent['state']; size?: number; title?: string }) {
  return (
    <span className={`gs-ava acc-${account} st-${state}`} style={{ width: size, height: size }} role="img" aria-label={title ?? `${agentName({ account })} · ${AGENT_STATE_LABEL[state]}`}>
      <span className="gs-ava-ring" aria-hidden="true" />
      <svg viewBox="0 0 48 48" width={size * 0.72} height={size * 0.72} aria-hidden="true">{FACES[account]}</svg>
    </span>
  );
}

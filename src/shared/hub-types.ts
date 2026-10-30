/** MSG Hub: the overview's read-only status of every mode, as `GET /api/hub/status` answers it. */

export type HubState = 'ok' | 'warn' | 'down' | 'idle' | 'unknown';
export const HUB_STATES: readonly HubState[] = ['ok', 'warn', 'down', 'idle', 'unknown'];

/** The eight status cards (the 개요 itself is the ninth switcher entry and has no card). */
export const HUB_MODE_IDS = ['msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant'] as const;
export type HubModeId = (typeof HUB_MODE_IDS)[number];

export type HubMetricValue = string | number | boolean | null;

export interface HubAlert {
  level: 'info' | 'warn' | 'bad';
  text: string;
  /** ISO time when known. */
  at?: string | null;
}

export interface HubLink {
  label: string;
  href: string;
  /** Same-origin path the hub shows inside its own frame (the proxy); other links open in a new tab. */
  embed?: boolean;
}

export interface HubSource {
  /** A short name, never a URL with credentials or a home path. */
  name: string;
  ok: boolean;
  ms: number;
  /** A short reason when `ok` is false (시간 초과, HTTP 503, 연결 실패). */
  error?: string;
}

export interface HubMode {
  id: HubModeId;
  name: string;
  state: HubState;
  lastActivity: string | null;
  /** Display label → value, in the order the card shows them. */
  metrics: Record<string, HubMetricValue>;
  alerts: HubAlert[];
  links: HubLink[];
  sources: HubSource[];
  /** A small badge next to the activity line (DRY RUN, PAPER). */
  tag?: string;
}

export interface HubStatus {
  modes: HubMode[];
  host: string;
  generated_at: string;
}

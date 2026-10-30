/** MSG Hub: the read-only status of every mode, as `GET /api/hub/status` (and the `hub_status` push) answers it. */

export type HubState = 'ok' | 'warn' | 'down' | 'idle' | 'unknown';
export const HUB_STATES: readonly HubState[] = ['ok', 'warn', 'down', 'idle', 'unknown'];

/** The nine status cards (the 개요 itself is the tenth switcher entry and has no card). */
export const HUB_MODE_IDS = ['msg', 'nexus', 'trading', 'video', 'game', 'ops', 'updown', 'quant', 'yapping'] as const;
export type HubModeId = (typeof HUB_MODE_IDS)[number];

export type HubMetricValue = string | number | boolean | null;

export type HubLevel = 'info' | 'warn' | 'bad';

export interface HubAlert {
  level: HubLevel;
  text: string;
  /** ISO time when known. */
  at?: string | null;
  /** What to look at (→ shown under the text). */
  hint?: string;
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

/** One KPI tile: label, a short value, an optional unit, a status colour and a one-line hint. */
export interface HubKpi {
  label: string;
  value: string;
  unit?: string;
  status?: 'ok' | 'warn' | 'bad' | 'info';
  hint?: string;
}

/** A drill-down block. `open` = shown expanded; everything else starts collapsed. */
export type HubSection =
  | { kind: 'kv'; title: string; note?: string; open?: boolean; rows: [string, string][] }
  | { kind: 'table'; title: string; note?: string; open?: boolean; columns: string[]; rows: string[][]; /** Right-aligned (numeric) column indexes. */ num?: number[] }
  | { kind: 'list'; title: string; note?: string; open?: boolean; items: { text: string; level?: HubLevel | 'ok'; hint?: string; at?: string | null }[] }
  | { kind: 'bars'; title: string; note?: string; open?: boolean; items: { label: string; value: number; text?: string }[] }
  | { kind: 'text'; title: string; note?: string; open?: boolean; body: string }
  /** 원본 보기: the GET-only proxy in a sandboxed frame (same origin) or an outside link in a new tab. */
  | { kind: 'raw'; title: string; note?: string; open?: boolean; href: string; embed?: boolean };

/** What a mode page says, in the order the template shows it: state line, decision line, KPIs, then drill-down. */
export interface HubPage {
  headline: string;
  decision: string;
  kpis: HubKpi[];
  sections: HubSection[];
}

export interface HubMode {
  id: HubModeId;
  name: string;
  state: HubState;
  lastActivity: string | null;
  /** Display label → value, in the order the card shows them. */
  metrics: Record<string, HubMetricValue>;
  /** 주의: what needs attention, worst first. */
  alerts: HubAlert[];
  links: HubLink[];
  sources: HubSource[];
  /** A small badge next to the activity line (DRY RUN, PAPER). */
  tag?: string;
  /** The mode's page (absent from an older server: the card shows metrics only). */
  page?: HubPage;
}

export interface HubStatus {
  modes: HubMode[];
  host: string;
  generated_at: string;
}

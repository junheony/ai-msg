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

/** One card in a `cards` section: an account, a printer, an episode, a game, a unit. */
export interface HubCardItem {
  title: string;
  /** A badge next to the title (호스트, 전략, 버전). */
  badge?: string;
  state?: HubState;
  /** A one-line status under the title. */
  sub?: string;
  /** Label → value rows (short). `status` colours the value. */
  rows: { label: string; value: string; status?: 'ok' | 'warn' | 'bad' | 'info' }[];
  /** A sparkline (equity, PnL); values only, oldest first. */
  spark?: { values: (number | null)[]; label?: string; unit?: string };
  /** Links out (플레이, 영상, 원본). */
  links?: HubLink[];
  /** A short note at the bottom (why it is in this state, what to do). */
  note?: string;
}

/** A time series the `chart` section draws: x labels (oldest first) and one or more series of the same length. */
export interface HubChartSeries { name: string; values: (number | null)[]; /** 'bar' draws columns; default line. */ style?: 'line' | 'bar'; color?: 'accent' | 'ok' | 'warn' | 'bad' | 'muted' }

/** A pipeline step (`steps` section). */
export interface HubStep { label: string; state: 'done' | 'active' | 'todo' | 'blocked'; hint?: string }

/** A thumbnail (`images` section): `src` is a same-origin read-only path (/api/hub/file/…) or an outside URL. */
export interface HubImage { src: string; label: string; /** Opens this (the video, the full image) in a new tab. */ href?: string; kind?: 'image' | 'video' | 'html' }

/** A drill-down block. `open` = shown expanded; everything else starts collapsed. */
export type HubSection =
  | { kind: 'kv'; title: string; note?: string; open?: boolean; rows: [string, string][] }
  | { kind: 'table'; title: string; note?: string; open?: boolean; columns: string[]; rows: string[][]; /** Right-aligned (numeric) column indexes. */ num?: number[]; /** Columns whose text may wrap (long reasons). */ wrap?: number[] }
  /** Per-entity cards (계정, 프린터, 에피소드, 게임, 유닛). */
  | { kind: 'cards'; title: string; note?: string; open?: boolean; items: HubCardItem[]; /** Preferred columns on a wide screen (2 or 3). */ cols?: 2 | 3 }
  /** A time-series chart (pure SVG): x labels and series; `unit` goes on the axis/tooltip; `zero` draws the zero line. */
  | { kind: 'chart'; title: string; note?: string; open?: boolean; x: string[]; series: HubChartSeries[]; unit?: string; zero?: boolean; /** Fixed y-min (e.g. 0 for equity). */ ymin?: number }
  /** A pipeline: steps left → right (done / active / todo / blocked). */
  | { kind: 'steps'; title: string; note?: string; open?: boolean; items: HubStep[] }
  /** Thumbnails / contact sheets / playable builds. */
  | { kind: 'images'; title: string; note?: string; open?: boolean; items: HubImage[] }
  /** Label + explanation + aligned number: readable money buckets (labels never clipped). */
  | { kind: 'kvgrid'; title: string; note?: string; open?: boolean; rows: { label: string; desc?: string; value: string; sub?: string; status?: 'ok' | 'warn' | 'bad' | 'info' }[] }
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
  /** NEXUS only: the ported home view's data (the standalone dashboard's /api/v2/home, secrets stripped). */
  nexus?: NexusHome;
  /** Trading Room only: the merged read-only view of the two bots (:8830 트레이딩룸, :8771/:8793 트레이딩-ver2). */
  trading?: TradingMerged;
}

/* ───────── NEXUS home (ported from the standalone dashboard, read-only) ───────── */

export interface NexusAction { id: string; kind: string; source: string; verdict: string; tone: string; title: string; action: string; href: string | null; nums: string[]; detail: string; fold: string | null }
export interface NexusOp { tone: string; cat: string; title: string; detail: string; ts: string | null; href: string | null }
export interface NexusListing { ex: string; sym: string; kind: string; network: string; notice_ts: string | null; open_ts: string | null; hedge_perp: string | null; m10: number | null; m30: number | null }
export interface NexusWalletRow { t: string | null; kind: string; who: string; sym: string; usd: number | null; venue: string; kr: boolean | null }
/** `sig` is the dashboard's row key (renamed: a field named `key` would be dropped by stripSecrets). */
export interface NexusScoreRow { sig: string; name: string; hit: number | null; scored: number | null; hit_pct: number | null; med_usd_1k: number | null; verdict: string; policy: string }
export interface NexusBin { t: string; max: number | null; sym: string | null; buy: string | null; sell: string | null }
export interface NexusHome {
  ts: string | null;
  late: boolean;
  /** Which parts of the home were still loading upstream (inbox, market, listing, band, kol). */
  late_what?: string[];
  head: { armed_n: number | null; kill: boolean | null; gap_age_s: number | null; failed_nexus: number | null; failed_all: number | null };
  actions: NexusAction[];
  near: NexusAction[];
  funnel: { total: number | null; route: number | null; ident: number | null; depth: number | null; net: number | null; pass: number | null };
  best_24h: string | null;
  ops: NexusOp[];
  kr: { ok: boolean | null; age_s: number | null; fresh: boolean | null; min_net: number | null; best_net: number | null; best_sym: string | null };
  listing: { ok: boolean | null; age_s: number | null; n_seen: number | null; upcoming: number | null; pending: number | null; recent: NexusListing[] };
  market: { btc: { v: number | null; px: number | null }; alt: { v: number | null; n: number | null }; kimp: { v: number | null; n: number | null }; pulse_age_s: number | null; blocked: boolean | null; /** Blocked-route counts per domestic exchange (the live `blocked` is this object, not a flag). */ blocked_n?: { upbit: number | null; bithumb: number | null } };
  peg: { bank: number | null; upbit_usdt: number | null; age_s: number | null; tprem: number | null };
  halts: string[];
  /** The dashboard's `wallet` block (renamed: a field named `wallet` would be dropped by stripSecrets). */
  flows: { ok: boolean | null; kol_ok: boolean | null; kol_age_s: number | null; persons24: number | null; usd24: number | null; feed: NexusWalletRow[]; coins: { sym: string; persons: number | null; usd: number | null }[]; deposits_hidden_n: number | null; deposits_min_usd: number | null };
  score: { ok: boolean | null; age_s: number | null; rows: NexusScoreRow[] };
  today: { real: { t: string | null; sym: string; route: string; net1k: number | null; why: string }[]; armed_n: number | null; day_start: string | null };
  band: { t0: string | null; t1: string | null; now: string | null; bin_s: number | null; bins: NexusBin[]; bins_age_s: number | null };
  /** Tabs of the standalone dashboard (지금/상장/갭/지갑/더보기) → outside links. */
  tabs: { label: string; href: string }[];
}

/* ───────── Trading Room (merged, read-only) ─────────
   Field names here never match SECRET_FIELD_RE (key/token/wallet/seed…): stripSecrets would drop them. */

export type TradingRowStatus = 'ok' | 'warn' | 'bad' | 'info';
export interface TradingRow { label: string; value: string; status?: TradingRowStatus }
/** One Trading Room workstream. The three are shown side by side and never merged: `pnl` is per workstream (null = the bot reports none). */
export interface TradingWorkstream { id: 'taker' | 'maker' | 'adaptive'; label: string; badge: string; state: HubState; rows: TradingRow[]; pnl: string | null; pnlNote: string; note: string }
export interface TradingRoomView {
  /** `live` = :8830 answered; `snapshot` = the file stood in; `none` = neither. */
  via: 'live' | 'snapshot' | 'none';
  error: string | null;
  state: string | null; stage: string | null;
  /** When the shown data was generated (status generated_at, or the snapshot's snapshot_generated_at). */
  generatedAt: string | null;
  /** Age of the shown data in hours (null when unknown); `stale` = a snapshot older than 24 h. */
  ageH: number | null; stale: boolean;
  /** :8830's own snapshot age (the bot's metric), shown even when live. */
  botSnapshotAgeH: number | null;
  workstreams: TradingWorkstream[];
  alerts: HubAlert[];
  kpis: HubKpi[];
}
export interface Ver2Book { id: string; label: string; strategy: string; tf: string; symbols: string[]; cashStart: number | null; equity: number | null; realized: number | null; unrealized: number | null; nTrades: number | null; wins: number | null; netPnl: number | null; avgR: number | null; maxDdPct: number | null; openN: number; lastBarKst: string | null; signalsSeen: number | null; spark: (number | null)[] }
export interface Ver2Position { book: string; sym: string; side: string; entry: number | null; stop: number | null; tp: number | null; qty: number | null; entryKst: string | null; mark: number | null; upnl: number | null; upnlPct: number | null }
export interface Ver2Trade { book: string; sym: string; side: string; entryKst: string | null; exitKst: string | null; entry: number | null; exit: number | null; reason: string; pnl: number | null; r: number | null }
export interface Ver2Event { kst: string | null; kind: string; msg: string }
export interface Ver2Paper {
  ok: boolean; error: string | null;
  live: boolean | null; mode: string | null; exchangeData: string | null; startedKst: string | null; firstStartKst: string | null; nowKst: string | null; uptimeS: number | null; loops: number | null; errors: number | null; lastError: string | null; lastPollKst: string | null; pollS: number | null; feePct: number | null; notionalFrac: number | null;
  books: Ver2Book[]; open: Ver2Position[]; trades: Ver2Trade[]; events: Ver2Event[];
  /** Equity per book on one time axis (downsampled, oldest first). */
  equity: { x: string[]; series: HubChartSeries[] } | null;
  rules: string | null; disclaimer: string | null;
}
export interface Ver2LedgerStat { book: string; signals: number | null; signalsCert: number | null; exits: number | null; exitsCert: number | null; rCertSum: number | null; latencyMedianS: number | null; progress: string | null }
export interface Ver2LedgerRecord { seq: number | null; tsKst: string | null; kind: string; strategy: string; sym: string; side: string; reason: string; pnlPaper: number | null; rPaper: number | null; rCert: number | null; certifiable: boolean | null }
export interface Ver2Ledger {
  ok: boolean; error: string | null;
  records: number | null; engineReady: boolean | null; lastPollKst: string | null; errors: number | null; lastError: string | null;
  stats: Ver2LedgerStat[]; maxLatencyS: number | null;
  verify: { ok: boolean | null; msg: string; n: number | null; warnings: string[] } | null;
  recent: Ver2LedgerRecord[];
}
export interface TradingMerged { room: TradingRoomView; ver2: { paper: Ver2Paper; ledger: Ver2Ledger } }

export interface HubStatus {
  modes: HubMode[];
  host: string;
  generated_at: string;
}

/**
 * Support/resistance zones the Trading room shows (read-only), as MSG's `/api/hub/sr` answers them. The server reads
 * two GET-only loopback feeds of the 트레이딩룸 bot — `:8830/api/sr` (auto MTF VPVR + pivot zones, paper only) and
 * `:8830/api/status` (room state, paper flags, snapshot metadata) — each with its own cache and last-good value, keeps
 * the fields the panel needs and nothing named like a secret or a home path. Prices are plain numbers in the symbol's
 * quote currency. Nothing here is a control.
 */

export type SrSide = 'support' | 'resistance';

export interface SrRange {
  id: string;
  symbol: string;
  side: SrSide;
  low: number;
  high: number;
  /** (low + high) / 2 — what the distance column measures from. */
  mid: number;
  /** The bot's raw score (Σ tf_weight × hit + SMA200) and its 1–5 confidence tier. */
  score: number | null;
  tier: number;
  /** Per-timeframe hit strength 0–1 (1m/5m/15m/1h/4h/1d, sometimes sma200_4h). */
  tfHits: Record<string, number>;
  timeframe: string;
  createdAt: string | null;
  expiresAt: string | null;
  /** The zone no longer holds once price closes beyond this (support: below, resistance: above). */
  invalidateBelow: number | null;
  invalidateAbove: number | null;
  /** The bot's own notes (short, scrubbed, bounded). */
  notes: string[];
}

export interface SrTimeframe { tf: string; profileDays: number | null; pivotDays: number | null; weight: number | null }

/** One upstream feed's health as the server last saw it. `lastGoodAt` survives later failures (the value shown is from then). */
export interface SrFeedMeta {
  /** Which loopback endpoint (path only, never a host or a file path). */
  endpoint: string;
  /** A value is being served (fresh or last-good). */
  ok: boolean;
  /** The value shown is a last-good one; `error` says why the latest read failed. */
  stale: boolean;
  error: string | null;
  /** When the served value was read (ISO, UTC). */
  fetchedAt: string | null;
  lastGoodAt: string | null;
}

/** A reported scalar, verbatim but bounded; the panel renders it as text. */
export type SrScalar = string | number | boolean | null;

/** The room's `/api/status`, reduced to what the SR / DCA section states. Every field is null when not reported. */
export interface SrRoomStatus {
  state: string | null;
  /** `paper` today; the badge is derived from this and the flags below — never hardcoded. */
  stage: string | null;
  generatedAt: string | null;
  lastActivity: string | null;
  paper: {
    adaptivePaperOnly: boolean | null;
    adaptiveLive: boolean | null;
    makerPaperEnabled: boolean | null;
    makerPaperMode: string | null;
    promotionEligible: boolean | null;
    makerGraftPromotionEligible: boolean | null;
  };
  /** The status feed's own description of the SR snapshot (file name, mtime, counts). */
  srSnapshot: { endpoint: string | null; source: string | null; mtime: string | null; ageHours: number | null; rangeCount: number | null; symbolCount: number | null; createdAt: string | null } | null;
  snapshotAgeH: number | null;
  snapshotGeneratedAt: string | null;
  maker: { universeCount: number | null; updatedAt: string | null; graftSmokeRows: number | null };
  onchain: { alertsCount: number | null; lastAlertAt: string | null; source: string | null };
  dwf: { basketCount: number | null; watchTotal: number | null; watchMtime: string | null; basketCoins: string[] };
  shadowHeartbeatAgeS: number | null;
  opsDocsCount: number | null;
  alerts: { level: 'info' | 'warn' | 'bad'; text: string; at: string | null }[];
  /** Split-buy / DCA paper state: the feed carries no fills or stages today, so this is `reported: false` with the reason. */
  dca: { reported: false; note: string } | { reported: true; rows: [string, SrScalar][] };
  /** Other reported scalar metrics (future fields), bounded; paths and secret-like names never pass. */
  extra: [string, SrScalar][];
}

export interface SrSnapshot {
  /** The snapshot file's name (no path) and its times, so the panel can say how old the zones are. */
  source: string;
  snapshotAt: string | null;
  createdAt: string | null;
  ageHours: number | null;
  policy: string;
  schemaVersion: string;
  method: { tiers: string; tfs: SrTimeframe[] };
  /** Every symbol in the snapshot (the link row), sorted; `ranges` is the filtered set when `symbol` is set. */
  symbols: string[];
  symbol: string | null;
  ranges: SrRange[];
  rangeCount: number;
  /** Split-buy paper status from the SR feed itself: the bot exposes none today, so the panel says 미보고 rather than inventing one. */
  splitBuy: { reported: false; note: string } | { reported: true; rows: [string, string][] };
  generatedAt: string | null;
  /** Per-source health; the answer is 200 as long as one of the two feeds has a value. */
  feeds: { sr: SrFeedMeta; status: SrFeedMeta };
  /** The room's status feed, or null when it has never answered. */
  room: SrRoomStatus | null;
}

/** What `/api/hub/sr` answers when neither feed does: never a stack, never a URL. */
export interface SrError { error: string }

export const SR_SYMBOL_RE = /^[A-Z0-9]{3,20}$/;

/** How the two feeds vouch for paper-only operation. `unverified` = status feed down, only the SR policy string speaks. */
export type SrPaperVerdict = 'paper' | 'unverified' | 'live-risk';

export function srPaperVerdict(s: Pick<SrSnapshot, 'room'>): SrPaperVerdict {
  const r = s.room;
  if (!r) return 'unverified';
  const liveFlag = r.paper.adaptiveLive === true || r.paper.adaptivePaperOnly === false || (r.paper.makerPaperMode !== null && r.paper.makerPaperMode !== 'paper');
  if (liveFlag || (r.stage !== null && r.stage !== 'paper')) return 'live-risk';
  return r.stage === 'paper' || r.paper.adaptivePaperOnly === true ? 'paper' : 'unverified';
}

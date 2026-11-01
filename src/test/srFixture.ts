/** Synthetic SR test data: a mapped `/api/hub/sr` answer with both feeds, shaped like the real :8830 room's status. */
import type { ReplayCandle } from '../shared/replay-types';
import type { SrRange, SrRoomStatus, SrSnapshot } from '../shared/sr-types';

export const SR_NOW = Date.parse('2026-10-31T09:00:00Z');
export const srZone = (id: string, symbol: string, side: SrRange['side'], low: number, high: number, tier: number, tfHits: Record<string, number> = { '1h': 1, '4h': 0.7, '1m': 0.2 }): SrRange => ({
  id, symbol, side, low, high, mid: (low + high) / 2, score: tier + 0.1, tier, tfHits, timeframe: 'MTF', createdAt: null, expiresAt: null, invalidateBelow: null, invalidateAbove: null, notes: [`tier=${tier}`],
});
export const SR_ZONES: SrRange[] = [
  srZone('far-res', 'BTCUSDT', 'resistance', 118_000, 118_400, 5),
  srZone('near-sup', 'BTCUSDT', 'support', 109_300, 109_700, 3),
  srZone('near-res', 'BTCUSDT', 'resistance', 110_900, 111_100, 2, { '1d': 1 }),
  srZone('far-sup', 'BTCUSDT', 'support', 100_000, 101_000, 4, {}),
  srZone('eth', 'ETHUSDT', 'support', 3_000, 3_050, 1),
];
export const SR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

export const srRoom = (over: Partial<SrRoomStatus> = {}): SrRoomStatus => ({
  state: 'ok', stage: 'paper', generatedAt: '2026-10-31T08:58:00Z', lastActivity: '2026-10-31T08:57:00Z',
  paper: { adaptivePaperOnly: true, adaptiveLive: false, makerPaperEnabled: true, makerPaperMode: 'paper', promotionEligible: false, makerGraftPromotionEligible: false },
  srSnapshot: { endpoint: '/api/sr', source: 'sr_ranges.json', mtime: '2026-10-31T06:30:00Z', ageHours: 2.5, rangeCount: 5, symbolCount: 3, createdAt: null },
  snapshotAgeH: 2.5, snapshotGeneratedAt: '2026-10-31T06:30:00Z',
  maker: { universeCount: 40, updatedAt: '2026-10-31T08:00:00Z', graftSmokeRows: 3 },
  onchain: { alertsCount: 2, lastAlertAt: '2026-10-31T07:00:00Z', source: 'whale_alert' },
  dwf: { basketCount: 2, watchTotal: 14, watchMtime: '2026-10-31T05:00:00Z', basketCoins: ['SOL', 'LINK'] },
  shadowHeartbeatAgeS: 12, opsDocsCount: 7,
  alerts: [{ level: 'warn', text: 'maker smoke rows low', at: '2026-10-31T08:50:00Z' }],
  dca: { reported: false, note: '/api/status 와 /api/sr 에 분할매수(DCA) 체결·단계 필드 없음 — stage·paper 플래그만 보고됨' },
  extra: [['new_metric_rows', 3], ['new_note', 'runs from …']],
  ...over,
});

export interface SrSnapOptions { room?: SrRoomStatus | null; srOk?: boolean; statusOk?: boolean; srStale?: boolean; symbols?: string[] }
export const srSnap = (symbol: string | null, o: SrSnapOptions = {}): SrSnapshot => {
  const ranges = symbol ? SR_ZONES.filter((z) => z.symbol === symbol) : SR_ZONES;
  const room = o.room === undefined ? srRoom() : o.room;
  const srOk = o.srOk ?? true, statusOk = o.statusOk ?? room !== null;
  return {
    source: 'sr_ranges.json', snapshotAt: '2026-10-31T06:30:00Z', createdAt: null, ageHours: 2.5, policy: 'paper_only; observe_only_until_absorption', schemaVersion: 'SRRangesFile_v1',
    method: { tiers: 'raw>=4.2:5, else 1', tfs: [] }, symbols: o.symbols ?? SR_SYMBOLS, symbol, ranges, rangeCount: ranges.length,
    splitBuy: { reported: false, note: '트레이딩룸(:8830)이 분할매수 페이퍼 상태를 내보내지 않음 — 미보고' }, generatedAt: new Date(SR_NOW - 60_000).toISOString(),
    feeds: {
      sr: { endpoint: '/api/sr', ok: srOk, stale: !!o.srStale, error: srOk && !o.srStale ? null : '연결 실패', fetchedAt: srOk ? '2026-10-31T08:59:00Z' : null, lastGoodAt: srOk ? '2026-10-31T08:59:00Z' : null },
      status: { endpoint: '/api/status', ok: statusOk, stale: false, error: statusOk ? null : '시간 초과', fetchedAt: statusOk ? '2026-10-31T08:59:00Z' : null, lastGoodAt: statusOk ? '2026-10-31T08:59:00Z' : null },
    },
    room,
  };
};
export const srCandles = (last: number, n = 5): ReplayCandle[] => Array.from({ length: n }, (_, i) => { const c = last - (n - 1 - i) * 10; return { t: SR_NOW - (n - i) * 3_600_000, o: c - 5, h: c + 20, l: c - 20, c, v: 1, q: c, tb: null }; });

import type { HubModeId, HubState } from '../../shared/hub-types';

/** The switcher's entries: the 개요 plus the eight modes. `msg` is the shell itself (the existing app, untouched). */
export type HubModeKey = 'home' | HubModeId;
export type HubIconName = 'grid' | 'terminal' | 'nodes' | 'candles' | 'clapper' | 'gamepad' | 'wrench' | 'updown' | 'bars';

export interface HubModeDef { id: HubModeKey; label: string; short: string; icon: HubIconName }

export const HUB_MODES: readonly HubModeDef[] = [
  { id: 'home', label: '개요', short: '개요', icon: 'grid' },
  { id: 'msg', label: 'MSG 터미널', short: '터미널', icon: 'terminal' },
  { id: 'nexus', label: 'NEXUS', short: 'NEXUS', icon: 'nodes' },
  { id: 'trading', label: 'Trading Room', short: '트레이딩', icon: 'candles' },
  { id: 'video', label: '영상 스튜디오', short: '영상', icon: 'clapper' },
  { id: 'game', label: '게임 스튜디오', short: '게임', icon: 'gamepad' },
  { id: 'ops', label: 'OPS · 펍덱', short: 'OPS', icon: 'wrench' },
  { id: 'updown', label: 'UPDOWN', short: 'UPDOWN', icon: 'updown' },
  { id: 'quant', label: 'QUANT', short: 'QUANT', icon: 'bars' },
];

export const HUB_MODE_KEY = 'deck.hubMode';
export const DEFAULT_HUB_MODE: HubModeKey = 'msg';

export function isHubModeKey(v: unknown): v is HubModeKey {
  return typeof v === 'string' && HUB_MODES.some((m) => m.id === v);
}
export function modeDef(id: HubModeKey): HubModeDef {
  return HUB_MODES.find((m) => m.id === id) ?? HUB_MODES[1]!;
}
/** ⌘1 … ⌘9 → the nth switcher entry. */
export function modeAt(n: number): HubModeKey | null {
  return HUB_MODES[n - 1]?.id ?? null;
}

/** The last mode this browser was in; the shell when none was kept (or storage is unavailable). */
export function readHubMode(): HubModeKey {
  try {
    const v = localStorage.getItem(HUB_MODE_KEY);
    return isHubModeKey(v) ? v : DEFAULT_HUB_MODE;
  } catch { return DEFAULT_HUB_MODE; }
}
export function writeHubMode(mode: HubModeKey): void {
  try { localStorage.setItem(HUB_MODE_KEY, mode); } catch { /* storage unavailable: not kept */ }
}

export const STATE_LABEL: Record<HubState, string> = { ok: '정상', warn: '주의', down: '장애', idle: '대기', unknown: '미확인' };

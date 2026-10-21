import { useSyncExternalStore } from 'react';

/**
 * ⚡ 빠르게 (Claude fast mode), per session and per browser: which sessions send their turns with `fast`, and whether
 * the person has once agreed to its usage-credit billing. Both live in localStorage (best effort — a blocked or corrupt
 * store reads as "off" / "not agreed"). Turning it on before agreeing parks the request (`pending`) for the consent sheet.
 */
export const FAST_KEY = 'deck.fast.v1';
export const FAST_CONSENT_KEY = 'deck.fastConsent.v1';
const MAX_SESSIONS = 200;
/** The ↯ chip's name (= the server's badge note). */
export const FAST_TITLE = '빠르게 · 사용 크레딧';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function readOn(): string[] {
  try {
    const v: unknown = JSON.parse(storage()?.getItem(FAST_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(-MAX_SESSIONS) : [];
  } catch { return []; }
}

let on: readonly string[] = readOn();
let consent = (() => { try { return storage()?.getItem(FAST_CONSENT_KEY) === '1'; } catch { return false; } })();
let pending: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function isFast(sessionId: string | null | undefined): boolean {
  return !!sessionId && on.includes(sessionId);
}

export function setFast(sessionId: string, value: boolean): void {
  if (isFast(sessionId) === value) return;
  on = value ? [...on.filter((x) => x !== sessionId), sessionId].slice(-MAX_SESSIONS) : on.filter((x) => x !== sessionId);
  try { storage()?.setItem(FAST_KEY, JSON.stringify(on)); } catch { /* best effort */ }
  notify();
}

export function hasFastConsent(): boolean { return consent; }

/** The switch: off at once; on at once once agreed, else the consent sheet asks first (`pendingFast`). */
export function requestFast(sessionId: string, value: boolean): void {
  if (!value || consent) { setFast(sessionId, value); return; }
  pending = sessionId;
  notify();
}

/** The consent sheet's answer: agreeing remembers it and turns the parked session on; declining drops the request. */
export function answerFastConsent(agree: boolean): void {
  const id = pending;
  pending = null;
  if (agree) {
    consent = true;
    try { storage()?.setItem(FAST_CONSENT_KEY, '1'); } catch { /* best effort */ }
    if (id) { setFast(id, true); return; }
  }
  notify();
}

export function useFast(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isFast(sessionId), () => false);
}

export function usePendingFast(): string | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}

/** Tests: reload from storage (after clearing it) and drop a parked request. */
export function resetFastForTests(): void {
  on = readOn();
  consent = (() => { try { return storage()?.getItem(FAST_CONSENT_KEY) === '1'; } catch { return false; } })();
  pending = null;
  notify();
}

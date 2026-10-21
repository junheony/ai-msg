import { useSyncExternalStore } from 'react';
import { FAST_NOTE } from '../shared/models';

/**
 * ⚡ 빠르게 (Claude fast mode), per session and per browser: which sessions send their turns with `fast`, and whether
 * the person has once agreed to its usage-credit billing. Both live in localStorage (best effort — a blocked or corrupt
 * store reads as "off" / "not agreed"). Every read goes to the store and every change is read-modify-write, so tabs
 * never overwrite each other; another tab's change arrives as a `storage` event and re-renders this one. Turning it on
 * before agreeing parks the request (`pending`) for the consent sheet.
 */
export const FAST_KEY = 'deck.fast.v1';
export const FAST_CONSENT_KEY = 'deck.fastConsent.v1';
const MAX_SESSIONS = 200;
/** The ↯ chip's name (= the server's badge note). */
export const FAST_TITLE = FAST_NOTE;

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

function readConsent(): boolean {
  try { return storage()?.getItem(FAST_CONSENT_KEY) === '1'; } catch { return false; }
}

let pending: string | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
// Another tab turned a switch or agreed (key null: that tab cleared the store).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === FAST_KEY || e.key === FAST_CONSENT_KEY) notify(); });
}

export function isFast(sessionId: string | null | undefined): boolean {
  return !!sessionId && readOn().includes(sessionId);
}

export function setFast(sessionId: string, value: boolean): void {
  const on = readOn();
  if (on.includes(sessionId) === value) return;
  const next = value ? [...on, sessionId].slice(-MAX_SESSIONS) : on.filter((x) => x !== sessionId);
  try { storage()?.setItem(FAST_KEY, JSON.stringify(next)); } catch { /* best effort */ }
  notify();
}

export function hasFastConsent(): boolean { return readConsent(); }

/** The switch: off at once; on at once once agreed, else the consent sheet asks first (`pendingFast`). */
export function requestFast(sessionId: string, value: boolean): void {
  if (!value || readConsent()) { setFast(sessionId, value); return; }
  pending = sessionId;
  notify();
}

/** The consent sheet's answer: agreeing remembers it and turns the parked session on; declining drops the request. */
export function answerFastConsent(agree: boolean): void {
  const id = pending;
  pending = null;
  if (agree) {
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

/** Tests: drop a parked request (the switches themselves are read from storage). */
export function resetFastForTests(): void {
  pending = null;
  notify();
}

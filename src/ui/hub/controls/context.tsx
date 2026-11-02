import { createContext, useContext, type ReactNode } from 'react';
import type { ControlsFeed } from './useControls';

/**
 * What the hub's cards and pages need to act: the controls feed, and the two ways out of a card — compose the next task
 * for a mode, or open its folder in the MSG terminal. Absent (tests, an older server) = no controls are drawn.
 */
export interface CtlContext {
  feed: ControlsFeed;
  compose: (mode: string) => void;
  /** `~/x` or absolute; the shell opens that folder's latest session, or a new chat there. */
  openTerminal?: (cwd: string) => void;
}

const Ctx = createContext<CtlContext | null>(null);

export function CtlProvider({ value, children }: { value: CtlContext | null; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useCtl = (): CtlContext | null => useContext(Ctx);

/** `~/x` → `<home>/x` (the terminal keys projects by absolute cwd). */
export function absCwd(home: string, cwd: string): string {
  if (cwd === '~') return home;
  return cwd.startsWith('~/') ? `${home.replace(/\/$/, '')}/${cwd.slice(2)}` : cwd;
}

/**
 * iOS / iPadOS home-screen app: the layout viewport sometimes comes out shorter than the window by the status-bar
 * height (after an in-app reload, mostly), which leaves a dead band under the whole shell even though it is pinned
 * with `inset: 0`. The window's own height (outerHeight) stays right, so the shortfall is measured and the document
 * itself is made that much taller with the shell laid out in it (`--shell-short` / `data-shell-fit`, styles.css
 * "shell fit"). A fixed box cannot do it: whatever it paints below the layout viewport is clipped.
 */
export type ShellMetrics = { standalone: boolean; inner: number; outer: number; vvHeight: number | null; vvScale: number; safeTop: number; /** screen.width / screen.height, either order. */ screen: [number, number] };

/** How far the shell must reach below the layout viewport (px); null = cannot tell right now (keyboard up, zoomed): keep the last value. */
export function shellShortfall(m: ShellMetrics): number | null {
  if (!m.standalone || m.inner <= 0 || m.outer <= 0) return 0;
  if (Math.abs(m.vvScale - 1) > 0.01 || (m.vvHeight !== null && m.vvHeight < m.inner * 0.8)) return null;
  const gap = Math.round(m.outer - m.inner);
  // Only the known shape of the bug: short by exactly the status bar. Anything else is left alone.
  // …in a window that fills the screen (a Stage Manager / split window is left alone).
  const full = m.screen.some((d) => Math.abs(d - m.outer) <= 2);
  return full && m.safeTop > 0 && Math.abs(gap - m.safeTop) <= 2 ? gap : 0;
}

let probe: HTMLElement | null = null;
function safeTop(): number {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.documentElement.appendChild(probe);
  }
  return Math.round(probe.getBoundingClientRect().height);
}

export function readShellMetrics(): ShellMetrics {
  const vv = window.visualViewport ?? null;
  return {
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    inner: window.innerHeight,
    outer: window.outerHeight,
    vvHeight: vv ? vv.height : null,
    vvScale: vv ? vv.scale : 1,
    safeTop: safeTop(),
    screen: [screen.width, screen.height],
  };
}

const KEY = 'deck.shellFit';
export const isHomeScreenApp = (): boolean => typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Off unless switched on in 설정 → 정보: the correction is unproven on real devices (a first attempt cut the bottom edge off). */
export function shellFitEnabled(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function setShellFit(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  fitShell();
}

export function fitShell(): void {
  const root = document.documentElement;
  const short = shellFitEnabled() ? shellShortfall(readShellMetrics()) : 0;
  // Keyboard up / zoomed: cannot measure, and the band is not on screen — back to the pinned shell until it can.
  if (short === null) { root.removeAttribute('data-shell-fit'); return; }
  if (short > 0) root.style.setProperty('--shell-short', `${short}px`);
  else root.style.removeProperty('--shell-short');
  root.toggleAttribute('data-shell-fit', short > 0);
}

/** One line for 설정 → 정보: what the device reports, for a screenshot when the bottom edge looks wrong. */
export function describeShell(): string {
  const m = readShellMetrics();
  const applied = document.documentElement.style.getPropertyValue('--shell-short') || '0';
  return `${window.innerWidth}×${m.inner} · 창 ${m.outer} · 화면 ${screen.width}×${screen.height} · 보이는 ${m.vvHeight === null ? '-' : Math.round(m.vvHeight)} · 위 ${m.safeTop} · 보정 ${applied}${m.standalone ? ' · 앱' : ''}`;
}

export function watchShell(): void {
  if (!isHomeScreenApp()) return;
  fitShell();
  for (const ev of ['resize', 'orientationchange', 'pageshow', 'focus']) window.addEventListener(ev, fitShell);
  window.visualViewport?.addEventListener('resize', fitShell);
  document.addEventListener('visibilitychange', fitShell);
  // The wrong height can settle a moment after load.
  for (const ms of [300, 1500, 4000]) setTimeout(fitShell, ms);
}

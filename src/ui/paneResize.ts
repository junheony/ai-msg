// Split-view column widths: each pane has a weight (`fr`), the splitters between them are fixed-width grid tracks.

/** Matches `--pane-min` in styles.css: a drag never squeezes a pane below it. */
export const PANE_MIN_PX = 300;
/** Width of a `.pane-splitter` track (styles.css). */
export const SPLITTER_PX = 6;
/** Floor for a stored weight, so a stray value can never collapse a pane to 0fr. */
export const MIN_PANE_SIZE = 0.05;

/** A usable weight, else 1 (absent, NaN, ≤ 0 or absurdly large values from storage). */
export function paneSize(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1000 ? Math.max(MIN_PANE_SIZE, x) : 1;
}

/** `grid-template-columns` for the panes and the splitters between them. */
export function paneColumns(sizes: readonly number[]): string {
  return sizes.map((s) => `minmax(var(--pane-min), ${Number(paneSize(s).toFixed(4))}fr)`).join(` ${SPLITTER_PX}px `);
}

/**
 * The two neighbours' new weights after the splitter between them moved `dx` px from where the drag began.
 * Only these two trade width (their weight sum stays, so every other pane keeps its fr share); each stays ≥ `minPx`.
 * `px` = their rendered widths at the start of the drag.
 */
export function resizePair(sizes: readonly [number, number], px: readonly [number, number], dx: number, minPx = PANE_MIN_PX): [number, number] {
  const a = paneSize(sizes[0]);
  const b = paneSize(sizes[1]);
  const total = px[0] + px[1];
  // Already at (or under) two minimums: nothing to trade.
  if (!(total > 2 * minPx) || !Number.isFinite(dx)) return [a, b];
  const left = Math.min(total - minPx, Math.max(minPx, px[0] + dx));
  const w = a + b;
  const na = (w * left) / total;
  return [na, w - na];
}

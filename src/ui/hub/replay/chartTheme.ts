/**
 * Colours for the replay chart, read from the shell's CSS tokens at mount (the canvas cannot read `var()`), plus a
 * fixed categorical order for indicator lines (the same eight hues stepped for light and dark surfaces).
 */
import type { CandleColors } from './history';

export interface ChartTheme {
  dark: boolean;
  bg: string;
  text: string;
  muted: string;
  faint: string;
  grid: string;
  border: string;
  accent: string;
  up: string;
  down: string;
  /** Eight categorical hues in fixed order: blue, orange, aqua, yellow, magenta, green, violet, red. */
  series: readonly string[];
  /** Axis text, from the shell's --fs-2xs step so the user's font scale applies to the canvas too. */
  textPx: number;
  fontFamily: string;
}

const LIGHT_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const;
const DARK_SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return true;
  const stamp = document.documentElement.getAttribute('data-theme');
  if (stamp === 'light') return false;
  if (stamp === 'dark') return true;
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches);
}

export function readChartTheme(el: Element, candleColors: CandleColors): ChartTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const dark = isDarkTheme();
  const series = dark ? DARK_SERIES : LIGHT_SERIES;
  const ok = v('--ok', dark ? '#7fae7a' : '#457841');
  const danger = v('--danger', dark ? '#e2675b' : '#c24136');
  // 국내 convention: red up, blue down (the palette's red and blue slots); 해외: the shell's ok/danger greens and reds.
  const [up, down] = candleColors === 'kr' ? [series[7]!, series[0]!] : [ok, danger];
  const textPx = Math.max(9, Math.round(parseFloat(v('--fs-2xs', '')) || 11 * (parseFloat(v('--font-scale', '1')) || 1)));
  return {
    textPx,
    fontFamily: cs.fontFamily || 'inherit',
    dark,
    bg: v('--bg-raised', dark ? '#1c1c26' : '#ececf2'),
    text: v('--fg', dark ? '#efeff6' : '#1c1c24'),
    muted: v('--muted', dark ? '#b3b1c2' : '#55546a'),
    faint: v('--faint', dark ? '#9b99ad' : '#656478'),
    grid: dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)',
    border: dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)',
    accent: v('--accent', dark ? '#a78bfa' : '#5b46c7'),
    up,
    down,
    series,
  };
}

/** The canvas text options for `createChart`'s layout (kept here so the TSX never sets a font size itself). */
export const chartText = (t: ChartTheme): { fontSize: number; fontFamily: string } => ({ fontSize: t.textPx, fontFamily: t.fontFamily });

/** `rgba()` of a hex colour, for soft fills (volume bars, histogram) behind lines. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

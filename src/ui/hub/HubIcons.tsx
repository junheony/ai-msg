import type { HubIconName } from './modes';

const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const PATHS: Record<HubIconName, string> = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  nodes: 'M12 5a2 2 0 1 0 0 .01M6 18a2 2 0 1 0 0 .01M18 18a2 2 0 1 0 0 .01M12 7v3M12 10l-5 6M12 10l5 6',
  candles: 'M7 4v3M7 15v5M5 7h4v8H5zM17 3v4M17 14v7M15 7h4v7h-4z',
  clapper: 'M4 9h16v11H4zM4 9l2-5h14l-2 5M9 4l-2 5M14 4l-2 5',
  gamepad: 'M7 8h10a4 4 0 0 1 4 4v2a3 3 0 0 1-5 2l-1-1H9l-1 1a3 3 0 0 1-5-2v-2a4 4 0 0 1 4-4zM8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01',
  wrench: 'M14 6a4 4 0 0 1 5 5l-8 8-3-3 8-8M4 20l3-3',
  updown: 'M8 20V5M5 8l3-3 3 3M16 4v15M13 16l3 3 3-3',
  bars: 'M4 20h16M7 17v-5M12 17V7M17 17v-8',
  bird: 'M21 6l-3 1a4 4 0 0 0-7 3v1C8 11 5 9 3 6c-1 4 0 8 4 10-1 1-3 1-4 1 2 2 5 3 8 3 7 0 11-6 11-11v-1l1-2',
};

export function HubIcon({ name, size = 16, className }: { name: HubIconName; size?: number; className?: string }) {
  return <svg {...svg} width={size} height={size} className={className}><path d={PATHS[name]} /></svg>;
}
export const ChevronDownIcon = () => <svg {...svg} width={14} height={14}><path d="M6 9l6 6 6-6" /></svg>;
export const ChevronRightIcon = () => <svg {...svg} width={14} height={14}><path d="M9 6l6 6-6 6" /></svg>;
export const CheckMarkIcon = () => <svg {...svg} width={14} height={14}><path d="M5 12l4 4 10-10" /></svg>;
export const ExternalIcon = () => <svg {...svg} width={14} height={14}><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
export const ReloadIcon = () => <svg {...svg} width={14} height={14}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>;

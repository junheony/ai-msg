/** Small line icons for message actions (Desktop style: 16px, currentColor stroke). */
const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const CopyIcon = () => <svg {...svg}><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v5.8c0 .6.5 1.1 1.1 1.1h1.9" /></svg>;
export const CheckIcon = () => <svg {...svg}><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const RetryIcon = () => <svg {...svg}><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.8v2.6h-2.6" /></svg>;
export const EditIcon = () => <svg {...svg}><path d="M10.6 2.9l2.5 2.5L6 12.5l-3 .5.5-3z" /></svg>;
/** Old usage numbers (the usage strip and sheet, 12px): a clock — when they were read. */
export const ClockIcon = ({ className }: { className?: string }) => <svg {...svg} width={12} height={12} strokeWidth={1.6} className={className}><circle cx="8" cy="8" r="5.6" /><path d="M8 4.9V8l2.1 1.4" /></svg>;
/** A usage window whose reset time has passed since it was read (12px): a refresh — one turn on the account reads it anew. */
export const RefreshIcon = ({ className }: { className?: string }) => <svg {...svg} width={12} height={12} strokeWidth={1.6} className={className}><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.8v2.6h-2.6" /></svg>;
export const FileIcon = ({ className, size = 16 }: { className?: string; size?: number }) => <svg {...svg} width={size} height={size} className={className}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></svg>;
/** 새 분할: a window split in two (the top bar's split button). */
export const ImageIcon = ({ className }: { className?: string }) => <svg {...svg} width={13} height={13} className={className}><rect x="2.5" y="3" width="11" height="10" rx="1.6" /><circle cx="6" cy="6.6" r="1.1" /><path d="M13.5 10.5l-3.2-3.2-5.8 5.7" /></svg>;
/** The › of a fold, drawn (a text › at 12px reads as a dot next to the line's · separators). Rotates open via .tool-caret. */
export const ChevronIcon = () => <svg {...svg} width={10} height={10} strokeWidth={1.8} className="tool-caret chev"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
export const SplitIcon = () => <svg {...svg}><rect x="2.5" y="3" width="11" height="10" rx="1.6" /><path d="M8 3v10" /></svg>;
export const ShareIcon = () => <svg {...svg}><path d="M8 10V2.5" /><path d="M5.2 5.2L8 2.4l2.8 2.8" /><path d="M5 7.5H4c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h8c.6 0 1-.4 1-1v-4c0-.6-.4-1-1-1h-1" /></svg>;

/** 고정됨 pin (sidebar rows, new-chat cards); filled when pinned. */
export function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M6 1.75h4l-.5 4.5 2.5 2.5v1H4v-1l2.5-2.5z" />
      <path d="M8 9.75v4.5" strokeLinecap="round" />
    </svg>
  );
}

/** Sidebar line-2 state tags (12px): 읽기 전용, 폴더 없음, 터미널에서 열림 — the word stays as screen-reader text. */
const tagSvg = { ...svg, width: 12, height: 12, strokeWidth: 1.6 } as const;
export const LockIcon = () => <svg {...tagSvg}><rect x="3.5" y="7" width="9" height="6.5" rx="1.4" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></svg>;
export const FolderOffIcon = () => <svg {...tagSvg}><path d="M2.5 5V12c0 .6.4 1 1 1h9c.6 0 1-.4 1-1V6.5c0-.6-.4-1-1-1H8L6.6 3.5H3.5c-.6 0-1 .4-1 1z" /><path d="M6.5 8l3 3M9.5 8l-3 3" /></svg>;
export const TerminalIcon = () => <svg {...tagSvg}><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M4.8 6.3L6.8 8l-2 1.7M8.5 10h2.7" /></svg>;

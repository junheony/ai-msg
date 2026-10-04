import { useLayoutEffect, type RefObject } from 'react';

/** Fits a textarea's height to its text; the CSS max-height caps it (then the textarea scrolls). */
export function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`;
}

/** Re-fits on every change of `value` (typing, a recalled message, the empty composer after a send). */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    if (ref.current) autoGrow(ref.current);
  }, [ref, value]);
}

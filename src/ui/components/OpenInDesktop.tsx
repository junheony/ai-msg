import { useRef } from 'react';
import { openInDesktop } from '../sessionApi';

/** Claude Desktop exists only on macOS; touch clients (iPad reporting as Mac) cannot hand off to it. */
export function canOpenInDesktop(): boolean {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) && !('ontouchend' in document);
}

/**
 * 세션 › Desktop에서 열기 (the session chip's menu): refreshes the Desktop copy, then hands the session to
 * `claude://resume`. Null = not offered (no session, not macOS, a touch client). A second pick while one runs is ignored.
 */
export function useOpenInDesktop(sessionId: string | null, onError: (message: string) => void, navigate: (url: string) => void = (url) => { window.location.href = url; }): (() => void) | null {
  const working = useRef(false);
  if (!sessionId || !canOpenInDesktop()) return null;
  return () => {
    if (working.current) return;
    working.current = true;
    void (async () => {
      try {
        const r = await openInDesktop(sessionId);
        if (!r.ok) { onError('기록이 갈라져 있어 먼저 맞춰야 합니다 (머리글의 \'갈라짐\' 메뉴)'); return; }
        if (r.busy && !window.confirm('AI-MSG 에서 아직 작업 중이라 Desktop 이 열기를 거절할 수 있습니다. 계속할까요?')) return;
        navigate(r.url);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Desktop 에서 열기 실패');
      } finally {
        working.current = false;
      }
    })();
  };
}

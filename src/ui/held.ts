import type { SessionHolder } from '../shared/session-types';

/**
 * The line above the composer of a session another `claude` process holds open (SessionEntry.heldBy). A warning only:
 * deck resumes from the transcript's newest entry on every send, so it picks up what the other side wrote; the other
 * process keeps the history it loaded and does not see deck's messages until it loads the session again.
 */
export function heldNote(by: SessionHolder): string {
  return by === 'desktop'
    ? 'Claude Desktop에도 열려 있는 세션입니다 — Desktop에서 보낸 내용은 deck이 이어받지만, deck에서 보낸 내용은 Desktop에서 세션을 다시 열어야 보입니다.'
    : '다른 Claude 프로세스(터미널 등)에도 열려 있는 세션입니다 — 그쪽에서 보낸 내용은 deck이 이어받지만, deck에서 보낸 내용은 그쪽에서 세션을 다시 열어야 보입니다.';
}

/** Sidebar row tag for such a session. */
export const heldTag = (by: SessionHolder): string => (by === 'desktop' ? 'Desktop 열림' : '다른 곳 열림');

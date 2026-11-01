import type { ReactNode } from 'react';
import { AttachMenu } from './AttachmentBar';
import { DictationButton } from './DictationButton';

/**
 * The one composer card (design §3.4), shared by a chat and the new-chat screen: the session chip above the text (top
 * left), the textarea, attachment chips, then a bottom row of + · mic · send/stop only (plus the two conditional
 * buttons, 대기열에 추가 and 작업으로, when they apply).
 */
export function Composer({ dragover, popup, chip, children, files, onFiles, text, onText, extra, hint, status, shortcut, action }: {
  dragover?: boolean;
  /** Slash / @file suggestions, anchored to the card. */
  popup?: ReactNode;
  chip: ReactNode;
  /** The textarea. */
  children: ReactNode;
  /** Attachment chips (null = none). */
  files?: ReactNode;
  onFiles: (files: File[]) => void;
  /** Dictation reads and writes the draft. */
  text: string;
  onText: (t: string) => void;
  /** Conditional round buttons left of send (대기열에 추가 · 작업으로). */
  extra?: ReactNode;
  /** A small control right of + (the prompt suggestion's 채우기). */
  hint?: ReactNode;
  /** Context/cache hint integrated into the composer surface. */
  status?: ReactNode;
  shortcut?: string | null;
  /** Send or stop. */
  action: ReactNode;
}) {
  return (
    <div className={`composer${dragover ? ' dragover' : ''}`}>
      {popup}
      <div className="composer-top">{chip}</div>
      {children}
      {status && <div className="composer-status">{status}</div>}
      {files && <div className="composer-files">{files}</div>}
      <div className="composer-row">
        <AttachMenu onFiles={onFiles} />
        {hint}
        {shortcut && <span className="composer-shortcut">{shortcut}</span>}
        <div className="composer-send">
          <DictationButton text={text} onText={onText} />
          {extra}
          {action}
        </div>
      </div>
    </div>
  );
}

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerMessage } from '../shared/protocol';
import type { HighlightEvent, HighlightKind } from '../shared/highlights';
import { selectPush } from './push/PushNotifier';
import { ABORTED, SHUTDOWN_ABORTED, SHUTDOWN_CUT_NOTICE } from './turn/TurnRunner';

/** How long `events.jsonl` keeps a line (older ones go at the next start, and from memory as new ones come in). */
export const HIGHLIGHT_KEEP_MS = 7 * 24 * 3600_000;
const BODY_MAX = 140;
/** A second 'interrupted' for the same session this soon is the same restart (a turn_result and its cut notice). */
const INTERRUPTED_DEDUPE_MS = 10_000;
const KINDS: readonly HighlightKind[] = ['turn', 'permission', 'question', 'task', 'interrupted', 'server'];

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parse(line: string): HighlightEvent | null {
  try {
    const e = JSON.parse(line) as Partial<HighlightEvent> | null;
    if (!e || typeof e.at !== 'number' || !KINDS.includes(e.kind as HighlightKind) || typeof e.cwd !== 'string' || typeof e.title !== 'string' || typeof e.body !== 'string') return null;
    if (e.sessionId !== null && typeof e.sessionId !== 'string') return null;
    return e as HighlightEvent;
  } catch {
    return null;
  }
}

/**
 * Which server events become a highlight (pure): what a push would be sent for (selectPush — a finished turn, a
 * waiting card, a settled background task), plus a turn or its background work cut by a server restart ('interrupted').
 */
export function selectEvent(msg: ServerMessage, titleOf: (sessionId: string | null, cwd: string) => string, at: number): HighlightEvent | null {
  if (msg.type === 'turn_notice' && msg.message.startsWith(SHUTDOWN_CUT_NOTICE)) {
    return { at, kind: 'interrupted', sessionId: msg.sessionId, cwd: msg.cwd, title: titleOf(msg.sessionId, msg.cwd) || 'deck', body: clip(msg.message, BODY_MAX) };
  }
  const p = selectPush(msg, titleOf);
  if (!p || p.kind === 'test') return null;
  const cwd = 'cwd' in msg && typeof msg.cwd === 'string' ? msg.cwd : '';
  if (msg.type === 'turn_result') {
    // The user's own stop: neither a result nor a failure worth remembering.
    if (!msg.ok && msg.errorText === ABORTED) return null;
    if (!msg.ok && msg.errorText === SHUTDOWN_ABORTED) return { at, kind: 'interrupted', sessionId: p.sessionId, cwd, title: p.title, body: SHUTDOWN_ABORTED };
    return { at, kind: 'turn', sessionId: p.sessionId, cwd, title: p.title, body: p.body, ok: msg.ok };
  }
  return { at, kind: p.kind, sessionId: p.sessionId, cwd, title: p.title, body: p.body };
}

/**
 * 하이라이트: an append-only `events.jsonl` of what happened per session (and to the server), the last 7 days kept
 * in memory for GET /api/highlights. Writes are queued appends; a write that fails is logged and the line lives on
 * in memory only.
 */
export class EventLog {
  /** Oldest first. */
  private events: HighlightEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly file: string, private readonly opts: { titleOf?: (sessionId: string | null, cwd: string) => string; now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Reads the file; lines older than 7 days (and broken ones) are dropped and the file is rewritten without them. */
  async load(): Promise<void> {
    const text = await fs.readFile(this.file, 'utf8').catch(() => '');
    const lines = text.split('\n').filter((l) => l.trim());
    const cutoff = this.now() - HIGHLIGHT_KEEP_MS;
    const kept = lines.map(parse).filter((e): e is HighlightEvent => e !== null && e.at >= cutoff).sort((a, b) => a.at - b.at);
    this.events = [...kept, ...this.events];
    // A last line without its newline (a write cut short) is rewritten too, so the next append starts on its own line.
    if (kept.length === lines.length && (text === '' || text.endsWith('\n'))) return;
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((err: unknown) => console.warn('deck: events.jsonl 정리 실패', err instanceof Error ? err.message : err));
    await this.queue;
  }

  /** Hook for every server event (next to the push notifier). */
  record(msg: ServerMessage): void {
    const e = selectEvent(msg, this.opts.titleOf ?? ((_s, cwd) => cwd.split('/').filter(Boolean).pop() ?? 'deck'), this.now());
    if (e) this.add(e);
  }

  /** The server itself: start, drain. */
  recordServer(body: string): void {
    this.add({ at: this.now(), kind: 'server', sessionId: null, cwd: '', title: '서버', body });
  }

  add(e: HighlightEvent): void {
    if (e.kind === 'interrupted') {
      const prev = this.events.findLast((x) => x.kind === 'interrupted' && x.sessionId === e.sessionId && x.cwd === e.cwd);
      if (prev && e.at - prev.at < INTERRUPTED_DEDUPE_MS) return;
    }
    this.events.push(e);
    const cutoff = this.now() - HIGHLIGHT_KEEP_MS;
    if (this.events[0] && this.events[0].at < cutoff) this.events = this.events.filter((x) => x.at >= cutoff);
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.file, JSON.stringify(e) + '\n', { mode: 0o600 });
    }).catch((err: unknown) => console.warn('deck: events.jsonl 기록 실패', err instanceof Error ? err.message : err));
  }

  /** Events at or after `sinceMs`, newest first. */
  query(sinceMs: number): HighlightEvent[] {
    return this.events.filter((e) => e.at >= sinceMs).sort((a, b) => b.at - a.at);
  }

  /** Resolves once every queued write is on disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }
}

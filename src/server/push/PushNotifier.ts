import webpush from 'web-push';
import type { ServerMessage } from '../../shared/protocol';
import { AUTO_RETRY_NOTICE } from '../turn/TurnRunner';
import type { PushSub, SubscriptionStore } from './SubscriptionStore';
import type { VapidKeys } from './vapid';

export type PushKind = 'turn' | 'permission' | 'question' | 'task' | 'test' | 'commander';

/** What the service worker receives (sw.js `push` handler). */
export type PushPayload = { kind: PushKind; title: string; body: string; sessionId: string | null; tag: string };

export type PushSendOptions = { TTL: number; urgency: 'normal' | 'high' };
export type PushSender = (sub: PushSub, payload: string, opts: PushSendOptions) => Promise<unknown>;

const TITLE_MAX = 60;
const BODY_MAX = 140;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First non-empty line, markdown heading/bullet marks dropped. */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Which server events become a push (pure, so the trigger rules are testable without a sender):
 * a finished turn, a waiting permission or question card, a background task that settled. (Which finished turns are
 * actually pushed is PushNotifier.notify's call — turnNeedsAttention; highlights take every one.)
 * Everything else (deltas, tool calls, resolutions, notices) → null.
 * Whether the user is already looking is decided by the service worker (a focused deck window suppresses it).
 */
export function selectPush(msg: ServerMessage, titleOf: (sessionId: string | null, cwd: string) => string): PushPayload | null {
  const head = (sessionId: string | null, cwd: string) => clip(titleOf(sessionId, cwd) || 'deck', TITLE_MAX);
  switch (msg.type) {
    case 'turn_result': {
      const line = firstLine(msg.ok ? msg.text : (msg.errorText ?? msg.text));
      const body = msg.ok ? `완료${line ? ` · ${line}` : ''}` : `실패${line ? ` · ${line}` : ''}`;
      return { kind: 'turn', title: head(msg.sessionId, msg.cwd), body: clip(body, BODY_MAX), sessionId: msg.sessionId, tag: `turn-${msg.sessionId ?? msg.turnId}` };
    }
    case 'permission_request': {
      const what = msg.title ? `${msg.toolName}: ${firstLine(msg.title)}` : msg.toolName;
      return { kind: 'permission', title: head(msg.sessionId, msg.cwd), body: clip(`권한 요청 · ${what}`, BODY_MAX), sessionId: msg.sessionId, tag: `ask-${msg.requestId}` };
    }
    case 'question_request': {
      const q = firstLine(msg.questions[0]?.question ?? '');
      return { kind: 'question', title: head(msg.sessionId, msg.cwd), body: clip(`질문 · ${q || '답을 기다립니다'}`, BODY_MAX), sessionId: msg.sessionId, tag: `ask-${msg.requestId}` };
    }
    case 'task_done': {
      const label = msg.status === 'completed' ? '백그라운드 작업 완료' : msg.status === 'failed' ? '백그라운드 작업 실패' : '백그라운드 작업 중지';
      const line = firstLine(msg.summary);
      return { kind: 'task', title: head(msg.sessionId, msg.cwd), body: clip(`${label}${line ? ` · ${line}` : ''}`, BODY_MAX), sessionId: msg.sessionId, tag: `task-${msg.sessionId ?? msg.turnId}` };
    }
    default:
      return null;
  }
}

/** A turn this long is worth a push even when it ends quietly. */
export const LONG_TURN_MS = 10 * 60_000;
/** turn_started times kept this long at most (a turn whose result never came). */
const STARTED_KEEP_MS = 24 * 3600_000;
/** Endings that ask the user to act (not 골라냈습니다 / 선택해서 적용했습니다 / 원하시면 언제든). */
const ASKS_USER = /할까요|하시겠어요|하시겠습니까|골라 ?주세요|선택해 ?주세요|확인해 ?주세요|결정해 ?주세요|알려 ?주세요|말씀해 ?주세요|진행할지|\blet me know\b|\bshould i\b|\bdo you want\b/i;
/** A heading that is, as a whole, one of these (a number before it allowed) — not 결정한 것 / 질문에 대한 답. */
const NEEDS_HEADING = /^(?:\d+[.)]\s*)?(?:남은 일|다음 단계|결정 필요|확인 필요|todo|질문)\s*:?$/i;
const ENDS_ASKING = /[?？][*_"'」』)\]\s]*$/;
const LIST_PARAGRAPH = /^(?:[-*+]|\d+[.)])\s/;

/**
 * Whether a finished turn needs the user (pure): it failed; it ran LONG_TURN_MS or more; its last paragraph asks
 * something (ends with ?, or asks to pick / confirm / tell) — a closing list is looked past to the paragraph before
 * it; or its last heading (#…###, a bold-only line) is a 남은 일 / 다음 단계 / 결정 필요 / 확인 필요 / TODO / 질문
 * section. Code fences are left out first. A quiet success is not pushed (it is still a highlight).
 */
export function turnNeedsAttention(text: string, ok: boolean, durationMs: number | null): boolean {
  if (!ok) return true;
  if (durationMs !== null && durationMs >= LONG_TURN_MS) return true;
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '');
  const paragraphs = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]!;
    if (ENDS_ASKING.test(p) || ASKS_USER.test(p)) return true;
    if (!LIST_PARAGRAPH.test(p)) break;
  }
  const heading = prose.split('\n').map((l) => l.trim()).map((l) => /^#{1,3}\s+(\S.*)$/.exec(l)?.[1] ?? /^\*\*([^*]+)\*\*:?$/.exec(l)?.[1]).filter((h) => h !== undefined).pop();
  return heading !== undefined && NEEDS_HEADING.test(heading.trim());
}

/** Push service host only — the endpoint path is a per-device secret-ish id and stays out of logs. */
function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return '?'; }
}

function statusOf(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : null;
}

export class PushNotifier {
  private readonly send: PushSender;

  constructor(private readonly opts: {
    store: SubscriptionStore;
    vapid: VapidKeys;
    /** VAPID `sub` claim: an https URL or mailto:. */
    subject: string;
    titleOf: (sessionId: string | null, cwd: string) => string;
    send?: PushSender;
    now?: () => number;
    /** 총사령탑이 이 세션을 실제로 돌리고 있다(Commander.quiet): 그때만 자동 턴 결과를 사령탑에 맡긴다. 없으면 늘 맡긴다. */
    commanderQuiet?: (sessionId: string) => boolean;
  }) {
    this.send = opts.send ?? ((sub, payload, o) => webpush.sendNotification(sub, payload, {
      ...o,
      vapidDetails: { subject: opts.subject, publicKey: opts.vapid.publicKey, privateKey: opts.vapid.privateKey },
    }));
  }

  get publicKey(): string {
    return this.opts.vapid.publicKey;
  }

  /** When each running turn started (first turn_started of its id): a long turn's result is pushed (turnNeedsAttention). */
  private readonly started = new Map<string, number>();
  /** Turns deck started by itself (AUTO_RETRY_NOTICE): the user only got the failure, so the outcome is always pushed. */
  private readonly autoRetried = new Set<string>();

  /** Fire-and-forget hook for every server event. Turn results only when they need the user (turnNeedsAttention). */
  notify(msg: ServerMessage): void {
    const now = this.opts.now?.() ?? Date.now();
    if (msg.type === 'turn_started') {
      for (const [id, at] of this.started) if (now - at > STARTED_KEEP_MS) { this.started.delete(id); this.autoRetried.delete(id); }
      if (!this.started.has(msg.turnId)) this.started.set(msg.turnId, now);
      return;
    }
    if (msg.type === 'turn_notice' && msg.message === AUTO_RETRY_NOTICE) { this.autoRetried.add(msg.turnId); return; }
    if (msg.type === 'turn_result') {
      // 총사령탑 자동 턴의 결과는 사령탑이 판정 뒤 사람 필요·완료·정지일 때만 따로 푸시한다(설계 §7) — 사령탑이 돌고 있을 때만.
      // 사람이 끼어들어 멈춘(paused·stopped) 뒤 끝난 자동 턴은 여느 턴처럼 푸시한다.
      if (msg.auto === 'commander' && (!this.opts.commanderQuiet || !msg.sessionId || this.opts.commanderQuiet(msg.sessionId))) { this.started.delete(msg.turnId); this.autoRetried.delete(msg.turnId); return; }
      const at = this.started.get(msg.turnId);
      this.started.delete(msg.turnId);
      const auto = this.autoRetried.delete(msg.turnId);
      // A background segment (`<turnId>:bg<n>`) only when it failed.
      if (!auto && (/:bg\d+$/.test(msg.turnId) ? msg.ok : !turnNeedsAttention(msg.text, msg.ok, at === undefined ? null : now - at))) return;
    }
    const payload = selectPush(msg, this.opts.titleOf);
    if (payload) void this.sendAll(payload);
  }

  async sendAll(payload: PushPayload): Promise<{ sent: number; removed: number }> {
    const results = await Promise.all(this.opts.store.list().map((sub) => this.deliver(sub, payload)));
    return { sent: results.filter((r) => r === 'ok').length, removed: results.filter((r) => r === 'gone').length };
  }

  /** Test button: only the asking device. false = not subscribed here (or delivery failed). */
  async sendTo(endpoint: string, payload: PushPayload): Promise<boolean> {
    const sub = this.opts.store.list().find((s) => s.endpoint === endpoint);
    return sub ? (await this.deliver(sub, payload)) === 'ok' : false;
  }

  private async deliver(sub: PushSub, payload: PushPayload): Promise<'ok' | 'gone' | 'fail'> {
    const urgent = payload.kind === 'permission' || payload.kind === 'question';
    try {
      await this.send(sub, JSON.stringify(payload), { TTL: urgent ? 30 * 60 : 6 * 3600, urgency: urgent ? 'high' : 'normal' });
      return 'ok';
    } catch (err) {
      const status = statusOf(err);
      // 404/410: the browser dropped this subscription — forget it.
      if (status === 404 || status === 410) {
        await this.opts.store.remove(sub.endpoint).catch(() => {});
        return 'gone';
      }
      console.error(`deck push: 전송 실패 (${hostOf(sub.endpoint)}, ${status ?? (err instanceof Error ? err.message : 'error')})`);
      return 'fail';
    }
  }
}

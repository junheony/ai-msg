import type { HighlightEvent } from '../../shared/highlights';
import type { HighlightCard } from './Highlights';

/** What the app knows right now (not from events.jsonl): cards waiting for an answer and sessions at work. */
export type HighlightLive = {
  waiting: { sessionId: string | null; kind: 'permission' | 'question' }[];
  activity: { sessionId: string; running: boolean; bg: number }[];
};

export type AttentionItem = { card: HighlightCard; need: string; tone: 'warn' | 'danger' };
export type ProgressItem = { card: HighlightCard; status: string };
export type HighlightSections = { attention: AttentionItem[]; progress: ProgressItem[]; done: HighlightCard[]; system: HighlightCard[] };

const LIMIT_RE = /한도|limit|quota|\b429\b/i;

/** A result line as plain text: markdown marks (`**`, backticks, headings, list bullets, links) gone, first sentence only. */
export function plainFirstSentence(s: string): string {
  const firstLine = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const plain = firstLine
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(#{1,6}|[-*+]|>|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`+|~~/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=\s|$|[.,!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^.*?[.!?。](?=\s)/.exec(plain);
  return m ? m[0] : plain;
}

/** A turn's reply line without its 완료/실패 prefix. */
function outcomeLine(e: HighlightEvent): string {
  return plainFirstSentence(e.kind === 'turn' ? e.body.replace(/^(완료|실패)(\s*·\s*|$)/, '') : e.body);
}

function waitedFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  return `${Math.floor(s / 3600)}시간`;
}

/**
 * Splits the 전체 view's cards (newest first, from groupHighlights) into what to look at:
 * - attention: a card waiting for an answer now (live), else a session whose latest outcome (turn or interruption)
 *   failed or was cut — a later finished turn settles it. Waiting first, then failures, then interruptions; newest first.
 * - progress: running or background work now (live), nothing to answer.
 * - done: the rest; system: the server's own card (start, drain).
 */
export function sectionHighlights(cards: HighlightCard[], live: HighlightLive | undefined, now: number): HighlightSections {
  const out: HighlightSections = { attention: [], progress: [], done: [], system: [] };
  const rank: number[] = [];
  for (const card of cards) {
    if (card.server) { out.system.push(card); continue; }
    const sid = card.sessionId;
    const wait = sid ? live?.waiting.find((w) => w.sessionId === sid) : undefined;
    if (wait) {
      const asked = card.events.find((e) => e.kind === wait.kind) ?? card.events.find((e) => e.kind === 'permission' || e.kind === 'question');
      const label = wait.kind === 'question' ? '질문 대기' : '승인 대기';
      out.attention.push({ card, need: asked ? `${label} · ${waitedFor(now - asked.at)}` : label, tone: 'warn' });
      rank.push(0);
      continue;
    }
    const act = sid ? live?.activity.find((a) => a.sessionId === sid) : undefined;
    if (act && (act.running || act.bg > 0)) {
      out.progress.push({ card, status: act.running ? '실행 중' : `백그라운드 ${act.bg}` });
      continue;
    }
    const outcome = card.events.find((e) => e.kind === 'turn' || e.kind === 'interrupted');
    if (outcome && outcome.kind === 'turn' && outcome.ok === false) {
      const line = outcomeLine(outcome);
      const need = LIMIT_RE.test(outcome.body) ? `한도로 끊김${line ? `: ${line}` : ''}` : `실패${line ? `: ${line}` : ''}`;
      out.attention.push({ card, need, tone: 'danger' });
      rank.push(1);
      continue;
    }
    if (outcome && outcome.kind === 'interrupted') {
      out.attention.push({ card, need: LIMIT_RE.test(outcome.body) ? '한도로 끊김' : '서버 재시작으로 끊김', tone: 'warn' });
      rank.push(2);
      continue;
    }
    out.done.push(card);
  }
  const order = out.attention.map((a, i) => ({ a, r: rank[i]! }));
  order.sort((x, y) => x.r - y.r || y.a.card.last - x.a.card.last);
  out.attention = order.map((x) => x.a);
  return out;
}

/** A finished session's one-line result: its latest finished turn's first sentence ('' = none). */
export function lastResultOf(card: HighlightCard): string {
  const e = card.events.find((x) => x.kind === 'turn' && x.ok !== false && outcomeLine(x));
  return e ? outcomeLine(e) : '';
}
